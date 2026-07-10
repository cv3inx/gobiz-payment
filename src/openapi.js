// OpenAPI 3.0 spec, served at /docs (Swagger UI) and /openapi.json.
// ponytail: hand-written object, not generated. It's small — regenerate by hand
// when endpoints change. See docs/API.md for prose.

const PORT = process.env.PORT || '3000';

const Transaction = {
   type: 'object',
   properties: {
      trxId: { type: 'string', example: 'TRX-K3F9Q2A7X1B4' },
      status: { type: 'string', enum: ['PENDING', 'PAID', 'EXPIRED'] },
      amount: { type: 'integer', example: 50000, description: 'Base price (rupiah)' },
      fee: { type: 'integer', example: 2500, description: 'Admin fee added to amount' },
      uniqueCode: { type: 'integer', example: 137, description: 'Random code (1..UNIQUE_CODE_MAX) added for matching' },
      amountToPay: {
         type: 'integer',
         example: 52637,
         description: 'The single number the payer transfers = amount + fee + uniqueCode. Match key; the QR encodes this.',
      },
      qrString: { type: 'string', description: 'Dynamic QRIS payload' },
      qrImageUrl: { type: 'string', example: 'https://pay.example.com/payment/TRX-K3F9Q2A7X1B4/qr.png' },
      callbackUrl: { type: 'string', nullable: true },
      metadata: { nullable: true },
      createdAt: { type: 'string', format: 'date-time' },
      expiresAt: { type: 'string', format: 'date-time' },
      paidAt: { type: 'string', format: 'date-time', nullable: true },
   },
};

const Error = {
   type: 'object',
   properties: {
      success: { type: 'boolean', example: false },
      error: { type: 'string' },
   },
};

function ok(schema) {
   return {
      type: 'object',
      properties: { success: { type: 'boolean', example: true }, data: schema },
   };
}

export const openApiSpec = {
   openapi: '3.0.3',
   info: {
      title: 'GoBiz Payment Gateway',
      version: '1.0.0',
      description:
         'Self-hosted QRIS payment gateway on top of GoPay Merchant (GoBiz). ' +
         'Matching uses **amountToPay** (amount + fee + tiny offset) — always show ' +
         'that value to the payer. See docs/API.md for details.',
   },
   servers: [{ url: `http://localhost:${PORT}` }],
   components: {
      securitySchemes: {
         ApiKeyAuth: { type: 'apiKey', in: 'header', name: 'X-API-Key', description: 'Set API_KEY in .env to enable' },
      },
      schemas: { Transaction, Error },
   },
   paths: {
      '/payment/create': {
         post: {
            summary: 'Create a payment',
            security: [{ ApiKeyAuth: [] }],
            parameters: [
               {
                  name: 'Idempotency-Key',
                  in: 'header',
                  required: false,
                  schema: { type: 'string' },
                  description: 'Reusing a key returns the original transaction.',
               },
            ],
            requestBody: {
               required: true,
               content: {
                  'application/json': {
                     schema: {
                        type: 'object',
                        required: ['amount'],
                        properties: {
                           amount: { type: 'integer', minimum: 1, example: 50000 },
                           fee: { type: 'integer', minimum: 0, example: 2500 },
                           trxId: {
                              type: 'string',
                              pattern: '^[\\w.-]{1,64}$',
                              example: 'ORDER-1042',
                              description: 'Custom ID; auto TRX-xxxx if omitted',
                           },
                           callbackUrl: {
                              type: 'string',
                              example: 'https://shop.example.com/hook',
                              description: 'Overrides WEBHOOK_URL for this trx',
                           },
                           expireMinutes: { type: 'integer', example: 10, description: 'Lifetime in minutes (default 5)' },
                           metadata: { description: 'Echoed back in status + webhook' },
                           idempotencyKey: { type: 'string' },
                        },
                     },
                     examples: {
                        minimal: { summary: 'Cuma amount', value: { amount: 50000 } },
                        withFee: {
                           summary: 'Fee + webhook + custom id',
                           value: {
                              amount: 50000,
                              fee: 2500,
                              trxId: 'ORDER-1042',
                              callbackUrl: 'https://shop.example.com/hook',
                           },
                        },
                        full: {
                           summary: 'Semua opsi',
                           value: {
                              amount: 50000,
                              fee: 2500,
                              trxId: 'ORDER-1042',
                              callbackUrl: 'https://shop.example.com/hook',
                              expireMinutes: 10,
                              metadata: { orderId: 1042 },
                           },
                        },
                     },
                  },
               },
            },
            responses: {
               201: { description: 'Created', content: { 'application/json': { schema: ok({ $ref: '#/components/schemas/Transaction' }) } } },
               200: { description: 'Idempotent hit — original transaction returned' },
               400: { description: 'Bad input', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
               401: { description: 'Missing/invalid API key' },
               409: { description: 'trxId already exists' },
               503: { description: 'No free amount slot — retry' },
            },
         },
      },
      '/payment/{trxId}': {
         get: {
            summary: 'Check payment by trxId',
            parameters: [{ name: 'trxId', in: 'path', required: true, schema: { type: 'string' } }],
            responses: {
               200: { description: 'OK', content: { 'application/json': { schema: ok({ $ref: '#/components/schemas/Transaction' }) } } },
               404: { description: 'Not found' },
            },
         },
      },
      '/payment/{trxId}/qr.png': {
         get: {
            summary: 'QRIS image (PNG)',
            parameters: [{ name: 'trxId', in: 'path', required: true, schema: { type: 'string' } }],
            responses: {
               200: { description: 'PNG image', content: { 'image/png': {} } },
               404: { description: 'Not found' },
            },
         },
      },
      '/payment/{trxId}/cancel': {
         post: {
            summary: 'Manually expire a pending payment',
            security: [{ ApiKeyAuth: [] }],
            parameters: [{ name: 'trxId', in: 'path', required: true, schema: { type: 'string' } }],
            responses: {
               200: { description: 'Cancelled' },
               404: { description: 'Not found' },
               409: { description: 'Not pending' },
            },
         },
      },
      '/payments': {
         get: {
            summary: 'List payments (newest first)',
            security: [{ ApiKeyAuth: [] }],
            parameters: [
               { name: 'status', in: 'query', schema: { type: 'string', enum: ['PENDING', 'PAID', 'EXPIRED'] } },
               { name: 'limit', in: 'query', schema: { type: 'integer', default: 50, maximum: 200 } },
               { name: 'offset', in: 'query', schema: { type: 'integer', default: 0 } },
            ],
            responses: { 200: { description: 'OK' } },
         },
      },
      '/history': {
         get: {
            summary: 'GoBiz transaction history (archived by the watcher)',
            description: 'Incoming GoBiz transactions mirrored to the local DB. ' +
               'matchedTrxId links an entry to one of your /payment/create orders.',
            security: [{ ApiKeyAuth: [] }],
            parameters: [
               { name: 'matched', in: 'query', schema: { type: 'boolean' }, description: 'true = only linked to an order, false = only unlinked' },
               { name: 'limit', in: 'query', schema: { type: 'integer', default: 50, maximum: 200 } },
               { name: 'offset', in: 'query', schema: { type: 'integer', default: 0 } },
            ],
            responses: { 200: { description: 'OK' } },
         },
      },
      '/health': {
         get: {
            summary: 'Health + counts',
            responses: { 200: { description: 'OK' } },
         },
      },
   },
};

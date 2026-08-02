// OpenAPI 3.0 spec, served at /docs (Swagger UI) and /openapi.json.
// ponytail: hand-written object, not generated. It's small — regenerate by hand
// when endpoints change. See docs/API.md for prose.

const PORT = process.env.PORT || '3000';
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/$/, '');

// Server list for "Try it out". PUBLIC_URL first when set; a relative "/" entry
// makes Swagger use the page's own origin (auto-detect, works anywhere it's served).
const SERVERS = [
   ...(PUBLIC_URL ? [{ url: PUBLIC_URL, description: 'Public' }] : []),
   { url: '/', description: 'This host (relative)' },
   { url: `http://localhost:${PORT}`, description: 'Local' },
];

const Transaction = {
   type: 'object',
   properties: {
      trxId: { type: 'string', example: 'TRX-K3F9Q2A7X1B4' },
      status: { type: 'string', enum: ['PENDING', 'PAID', 'EXPIRED'], example: 'PENDING' },
      amount: { type: 'integer', example: 50000, description: 'Base price (rupiah)' },
      fee: { type: 'integer', example: 2500, description: 'Admin fee added to amount' },
      uniqueCode: {
         type: 'integer',
         minimum: 1,
         example: 37,
         description: 'Sequential code (1..UNIQUE_CODE_MAX, wraps to 1) added for payment matching',
      },
      amountToPay: {
         type: 'integer',
         example: 52537,
         description: 'The single number the payer transfers = amount + fee + uniqueCode. Match key; the QR encodes this.',
      },
      qrString: { type: 'string', example: '00020101021226...5802ID...6304ABCD', description: 'Dynamic QRIS payload' },
      qrImageUrl: { type: 'string', example: 'https://pay.example.com/payment/TRX-K3F9Q2A7X1B4/qr.png' },
      callbackUrl: { type: 'string', nullable: true, example: 'https://shop.example.com/hook' },
      metadata: { nullable: true, example: { orderId: 1042 } },
      createdAt: { type: 'string', format: 'date-time', example: '2026-07-10T12:24:56.000Z' },
      expiresAt: { type: 'string', format: 'date-time', example: '2026-07-10T12:29:56.000Z' },
      paidAt: { type: 'string', format: 'date-time', nullable: true, example: null, description: 'null while PENDING; set when PAID' },
      webhook: {
         type: 'object',
         nullable: true,
         description: 'Delivery state. null while nothing is owed.',
         properties: {
            state: { type: 'string', enum: ['PENDING', 'SENT'] },
            attempts: { type: 'integer' },
            nextAttemptAt: { type: 'string', format: 'date-time', nullable: true },
            lastError: { type: 'string', nullable: true, example: 'ECONNREFUSED' },
         },
      },
   },
   example: {
      trxId: 'TRX-K3F9Q2A7X1B4',
      status: 'PENDING',
      amount: 50000,
      fee: 2500,
      uniqueCode: 137,
      amountToPay: 52637,
      qrString: '00020101021226...5802ID...6304ABCD',
      qrImageUrl: 'https://pay.example.com/payment/TRX-K3F9Q2A7X1B4/qr.png',
      callbackUrl: 'https://shop.example.com/hook',
      metadata: { orderId: 1042 },
      createdAt: '2026-07-10T12:24:56.000Z',
      expiresAt: '2026-07-10T12:29:56.000Z',
      paidAt: null,
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
         'Self-hosted QRIS payment gateway. Create payments, generate dynamic ' +
         'QR codes, track status by transaction ID, and receive signed webhooks ' +
         'when a payment is settled. See docs/API.md for the full guide.\n\n' +
         '📦 **Source:** [github.com/cv3inx/gobiz-payment](https://github.com/cv3inx/gobiz-payment)',
      contact: { name: 'GitHub — cv3inx/gobiz-payment', url: 'https://github.com/cv3inx/gobiz-payment' },
      license: { name: 'MIT', url: 'https://github.com/cv3inx/gobiz-payment/blob/main/LICENSE' },
   },
   externalDocs: {
      description: 'GitHub repository',
      url: 'https://github.com/cv3inx/gobiz-payment',
   },
   servers: SERVERS,
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
                           amount: { type: 'integer', minimum: 1, maximum: 1000000000, example: 50000 },
                           fee: { type: 'integer', minimum: 0, maximum: 1000000000, example: 2500 },
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
               500: { description: 'Internal error' },
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
      '/payment/{trxId}/replay-webhook': {
         post: {
            summary: 'Re-queue a webhook that exhausted its retry attempts',
            description: 'Use when the consumer was down longer than the retry window ' +
               '(WEBHOOK_MAX_ATTEMPTS). Resets the attempt counter; the sweeper redelivers.',
            security: [{ ApiKeyAuth: [] }],
            parameters: [{ name: 'trxId', in: 'path', required: true, schema: { type: 'string' } }],
            responses: {
               200: { description: 'Re-queued' },
               404: { description: 'Not found' },
               409: { description: 'Transaction still PENDING — nothing to replay' },
            },
         },
      },
      '/payments': {
         get: {
            summary: 'List payments (newest first)',
            security: [{ ApiKeyAuth: [] }],
            parameters: [
               { name: 'status', in: 'query', schema: { type: 'string', enum: ['PENDING', 'PAID', 'EXPIRED'] }, description: 'Any other value returns 400' },
               { name: 'limit', in: 'query', schema: { type: 'integer', default: 50, minimum: 1, maximum: 200 }, description: 'Clamped to 1..200' },
               { name: 'offset', in: 'query', schema: { type: 'integer', default: 0, minimum: 0 } },
            ],
            responses: { 200: { description: 'OK' }, 400: { description: 'Invalid status' } },
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
               { name: 'limit', in: 'query', schema: { type: 'integer', default: 50, minimum: 1, maximum: 200 }, description: 'Clamped to 1..200' },
               { name: 'offset', in: 'query', schema: { type: 'integer', default: 0, minimum: 0 } },
            ],
            responses: { 200: { description: 'OK' } },
         },
      },
      '/health': {
         get: {
            summary: 'Health, counts, webhook backlog, and GoBiz session state',
            description: 'Returns 503 when the upstream GoBiz session is down — payments ' +
               'cannot be detected, so the instance is degraded. Point uptime monitors here.',
            responses: {
               200: {
                  description: 'Healthy',
                  content: {
                     'application/json': {
                        example: {
                           success: true,
                           data: {
                              pending: 3,
                              total: 128,
                              webhooksOwed: 0,
                              uniqueCodeCursor: 37,
                              session: {
                                 ok: true,
                                 lastCheckAt: '2026-07-10T12:30:00.000Z',
                                 lastOkAt: '2026-07-10T12:30:00.000Z',
                                 consecutiveFailures: 0,
                                 reauths: 2,
                                 lastError: null,
                              },
                           },
                        },
                     },
                  },
               },
               503: {
                  description: 'GoBiz session down — payments cannot be detected',
                  content: {
                     'application/json': {
                        example: {
                           success: false,
                           data: {
                              pending: 3,
                              total: 128,
                              webhooksOwed: 1,
                              uniqueCodeCursor: 37,
                              session: {
                                 ok: false,
                                 lastCheckAt: '2026-07-10T12:30:00.000Z',
                                 lastOkAt: '2026-07-10T11:58:00.000Z',
                                 consecutiveFailures: 4,
                                 reauths: 2,
                                 lastError: 'Login di-cooldown 890s',
                              },
                           },
                        },
                     },
                  },
               },
            },
         },
      },
   },
};

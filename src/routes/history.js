import express from 'express';
import * as history from '../db/history.js';
import { clampPage } from '../db/transactions.js';

export function historyRoutes(guard) {
   const router = express.Router();

   // Incoming GoBiz transactions archived by the watcher. ?matched=true|false
   router.get('/history', guard, (req, res) => {
      const matched = req.query.matched == null ? null : req.query.matched === 'true';
      const { limit, offset } = clampPage(req.query);
      const data = history.list({ matched, limit, offset });
      res.json({ success: true, data, meta: { limit, offset, count: data.length } });
   });

   return router;
}

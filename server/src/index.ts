import './utils/load-env.js';
import express from 'express';
import { generateRouter } from './routes/generate.js';
import { extractRouter } from './routes/extract.js';
import { createPublicToolsApp, mountPublicTools } from './public-tools.js';
import { otariRouter } from './routes/otari.js';

const app = express();

// Middleware
app.use(express.json());

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Routes
app.use('/generate', generateRouter);
app.use('/extract', extractRouter);
mountPublicTools(app);
app.use('/api/otari', otariRouter);

// Error handler
app.use((err: Error, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// Start server
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`Structura server listening on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
});

// Locally, the gateway-facing routes also get a loopback listener of their own for
// scripts/tunnel.sh to expose. A deployed server serves them on PORT instead.
const toolsPort = process.env.PUBLIC_TOOLS_PORT ?? '8090';
if (process.env.NODE_ENV !== 'production' && toolsPort !== 'off') {
  createPublicToolsApp().listen(Number(toolsPort), '127.0.0.1', () => {
    console.log(`Gateway-facing tools (MCP, guardrail) on http://127.0.0.1:${toolsPort}`);
  });
}

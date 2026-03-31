const { createServer } = require('../dist/server');
const { initializeDatabase } = require('../dist/config/database');

const app = createServer({ includeStatic: true });
let initPromise;

function ensureInitialized() {
  if (!initPromise) {
    initPromise = initializeDatabase();
  }
  return initPromise;
}

module.exports = async (req, res) => {
  try {
    await ensureInitialized();
    return app(req, res);
  } catch (error) {
    console.error('Failed to initialize API handler', error);
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Server initialization failed' }));
  }
};

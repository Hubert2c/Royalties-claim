// =============================================================================
// licensee-server.js — serves the Licensee portal on its own port (3002)
// -----------------------------------------------------------------------------
// Optional: the same portal is also available at http://localhost:3001/licensee.
// (This replaces the old "reviewer" portal: reviewing is now done by the
// government administrator in the main console.)
// =============================================================================

const express = require('express');
const path = require('path');

const app = express();
const PORT = Number(process.env.LICENSEE_PORT) || 3002;

app.use('/shared', express.static(path.join(__dirname, 'shared')));
app.get('/styles.css', (req, res) => res.sendFile(path.join(__dirname, 'styles.css')));
app.use('/licensee', express.static(path.join(__dirname, 'licensee')));
app.use('/', express.static(path.join(__dirname, 'licensee')));

const server = app.listen(PORT, () => {
  if (process.env.NODE_ENV !== 'test') console.log(`Licensee portal running on http://localhost:${PORT}`);
});

module.exports = { app, server, config: { PORT } };
if (require.main !== module) server.unref();

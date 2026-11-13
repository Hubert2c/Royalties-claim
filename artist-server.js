// =============================================================================
// artist-server.js — serves the Rights-holder portal on its own port (8000)
// -----------------------------------------------------------------------------
// Optional: the same portal is also available at http://localhost:3001/artist.
// This separate port mirrors how the portals could be hosted on separate
// domains in production. The pages call the API on port 3001 (see shared/ui.js).
// =============================================================================

const express = require('express');
const path = require('path');

const app = express();
const PORT = Number(process.env.ARTIST_PORT) || 8000;

app.use('/shared', express.static(path.join(__dirname, 'shared')));
app.get('/styles.css', (req, res) => res.sendFile(path.join(__dirname, 'styles.css')));
app.use('/artist', express.static(path.join(__dirname, 'artist')));
app.use('/', express.static(path.join(__dirname, 'artist')));

const server = app.listen(PORT, () => {
  if (process.env.NODE_ENV !== 'test') console.log(`Rights-holder portal running on http://localhost:${PORT}`);
});

module.exports = { app, server, config: { PORT } };
if (require.main !== module) server.unref();

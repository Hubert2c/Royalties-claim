const express = require('express');
const path = require('path');

const app = express();
const PORT = Number(process.env.PORT) || 8000;

app.use(express.static(path.join(__dirname, 'artist')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'artist', 'index.html'));
});

app.get(/^(?!\/api).*/, (req, res) => {
  res.sendFile(path.join(__dirname, 'artist', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Artist portal running on http://localhost:${PORT}`);
});

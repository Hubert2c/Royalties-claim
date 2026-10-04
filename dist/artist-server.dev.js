"use strict";

var express = require('express');

var path = require('path');

var app = express();
var PORT = Number(process.env.PORT) || 8000;
app.use(express["static"](path.join(__dirname, 'artist')));
app.get('/', function (req, res) {
  res.sendFile(path.join(__dirname, 'artist', 'index.html'));
});
app.get(/^(?!\/api).*/, function (req, res) {
  res.sendFile(path.join(__dirname, 'artist', 'index.html'));
});
app.listen(PORT, function () {
  console.log("Artist portal running on http://localhost:".concat(PORT));
});
//# sourceMappingURL=artist-server.dev.js.map

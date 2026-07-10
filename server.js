var express = require('express');
var morgan = require('morgan');
var path = require('path');
var app = express();

app.use(morgan('dev'));
app.use(express.static(path.join(__dirname, 'public')));

// The map app handles /drive, /bike and /walk as client-side tabs,
// but serve the same page for direct visits to those paths.
['/', '/drive', '/bike', '/walk'].forEach(function (route) {
    app.get(route, function (request, response) {
        response.sendFile(path.join(__dirname, 'public', 'index.html'));
    });
});

app.get('/nickname', function (request, response) {
    response.send('rich dragonfly');
});

app.listen(process.env.PORT || 4000);

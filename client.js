"use strict";
exports.__esModule = true;
// Include Nodejs' net module.
var Net = require("net");
let packet = require('./js/packet');
var processor = packet.processor();

// The port number and hostname of the server.
var port = 8078;
var host = 'localhost';
// Create a new TCP client.
var client = new Net.Socket();
// Send a connection request to the server.
client.connect(({ port: port, host: host }), function () {
    // If there is no error, the server has accepted the request and created a new 
    // socket dedicated to us.
    console.log('TCP connection established with the server.');
    const test1 = processor.encode('ÿÿ\x03 \x03\x01\x01\x1Eq\v1124073472');

    // The client can now send data to the server by writing to its socket.
    client.write(test1);
});
// The client can also receive data from the server by reading from its socket.
client.on('data', function (chunk) {
    console.log("Data received from the server: ".concat(chunk.toString(), "."));
    // Request an end to the connection after the data has been received.
    client.end();
});
client.on('end', function () {
    console.log('Requested an end to the TCP connection');
});

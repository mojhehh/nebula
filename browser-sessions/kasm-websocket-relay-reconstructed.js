// ============================================================================
// RECONSTRUCTED: Kasm websocket-relay.js (kasm_audio_out-linux)
// ============================================================================
// Source: Extracted from pkg-compiled Node.js binary (40.5 MB ELF)
//   - File: /dockerstartup/jsmpeg/kasm_audio_out-linux (inside Kasm Docker container)
//   - Virtual path: /snapshot/kasm_websocket_relay/websocket-relay.js
//   - Package: kasm_audio_out v0.0.1, by Kasm Technologies LLC
//   - License: Kasm Server License
//   - Original source size: 3617 bytes (from pkg metadata)
//
// Reconstruction method:
//   V8 bytecode string constants extracted from binary at offset ~37904800
//   compared with the original jsmpeg websocket-relay.js (phoboslab/jsmpeg)
//
// Kasm modifications vs original jsmpeg:
//   1. SSL/TLS support: HTTPS stream server + WSS WebSocket server
//   2. Basic Auth on stream server (Authorization header with base64 token)  
//   3. AUTH_TOKEN as 7th CLI argument (argv[7])
//   4. SSL cert/key as argv[5]/argv[6]
//   5. Uses 'server' option for WebSocket.Server (rides on HTTPS server)
//
// CRITICAL FINDING:
//   - There is NO verifyClient or auth check on the WebSocket server itself
//   - The Basic Auth check is ONLY on the HTTP stream server (ffmpeg -> relay)
//   - WebSocket connections from browsers are accepted WITHOUT authentication
//   - The WebSocket server does NOT send Close frames; it simply accepts connections
//   - If you see immediate Close frames, the issue is NOT in this relay code
//
// Invocation (from vnc_startup.sh):
//   $STARTUPDIR/jsmpeg/kasm_audio_out-linux kasmaudio 8081 4901 \
//     ${HOME}/.vnc/self.pem ${HOME}/.vnc/self.pem "kasm_user:$VNC_PW"
// ============================================================================

var fs = require('fs'),
	https = require('https'),
	http = require('http'),
	WebSocket = require('ws');

var STREAM_SECRET = process.argv[2],   // "kasmaudio"
	STREAM_PORT = process.argv[3],     // 8081 (ffmpeg sends MPEG-TS here)
	WEBSOCKET_PORT = process.argv[4],  // 4901 (browser connects here for audio)
	RECORD_STREAM = false;

var SSL_CERT_PATH = process.argv[5],   // e.g. /home/kasm-user/.vnc/self.pem
	SSL_KEY_PATH = process.argv[6],    // e.g. /home/kasm-user/.vnc/self.pem
	AUTH_TOKEN = process.argv[7];      // e.g. "kasm_user:<password>"

if (process.argv.length < 3) {
	console.log(
		'Usage: \n' +
		'node websocket-relay.js <url-path> <stream-port> <websocket-port> ' +
		'<ssl-cert> <ssl-cert-key> [<auth-token>]'
	);
	process.exit();
}

// --- WebSocket Server (for browser clients, on port 4901) ---
// When SSL cert is provided, create an HTTPS server and attach WS to it
var socketServer;
if (SSL_CERT_PATH) {
	var wsServer = https.createServer({
		cert: fs.readFileSync(SSL_CERT_PATH),
		key: fs.readFileSync(SSL_KEY_PATH)
	});
	wsServer.listen(WEBSOCKET_PORT);
	socketServer = new WebSocket.Server({
		server: wsServer,
		perMessageDeflate: false
	});
} else {
	socketServer = new WebSocket.Server({
		port: WEBSOCKET_PORT,
		perMessageDeflate: false
	});
}

socketServer.connectionCount = 0;

socketServer.on('connection', function(socket, upgradeReq) {
	socketServer.connectionCount++;
	console.log(
		'New WebSocket Connection: ',
		(upgradeReq || socket.upgradeReq).socket.remoteAddress,
		(upgradeReq || socket.upgradeReq).headers['user-agent'],
		'(' + socketServer.connectionCount + ' total)'
	);
	socket.on('close', function(code, message) {
		socketServer.connectionCount--;
		console.log(
			'Disconnected WebSocket (' + socketServer.connectionCount + ' total)'
		);
	});
});

// Broadcast data to all connected WebSocket clients
socketServer.broadcast = function(data) {
	socketServer.clients.forEach(function each(client) {
		if (client.readyState === WebSocket.OPEN) {
			client.send(data);
		}
	});
};

// --- HTTP(S) Stream Server (for ffmpeg input, on port 8081) ---
var streamServer = (SSL_CERT_PATH ? https : http).createServer(
	SSL_CERT_PATH ? {
		cert: fs.readFileSync(SSL_CERT_PATH),
		key: fs.readFileSync(SSL_KEY_PATH)
	} : undefined,
	function(request, response) {
		var params = request.url.substr(1).split('/');

		if (params[0] !== STREAM_SECRET) {
			console.log(
				'Failed Stream Connection: ' + request.socket.remoteAddress + ':' +
				request.socket.remotePort + ' - wrong secret.'
			);
			response.end();
		}

		// Basic Auth verification (AUTH_TOKEN = "kasm_user:password")
		if (AUTH_TOKEN) {
			var authorization = request.headers['authorization'];
			if (!authorization) {
				console.log('Authorization header missing but required');
				response.end('Access denied');
				return;
			}
			// "Basic <base64>" -> decode the base64 part (skip "Basic " = 6 chars)
			var token = Buffer.from(authorization.substring(6), 'base64').toString('ascii');
			if (token !== AUTH_TOKEN) {
				console.log('Access denied');
				response.end('Access denied');
				return;
			}
		}

		response.connection.setTimeout(0);
		console.log(
			'Stream Connected: ' +
			request.socket.remoteAddress + ':' +
			request.socket.remotePort
		);

		request.on('data', function(data) {
			socketServer.broadcast(data);
			if (request.socket.recording) {
				request.socket.recording.write(data);
			}
		});

		request.on('end', function() {
			console.log('close');
			if (request.socket.recording) {
				request.socket.recording.close();
			}
		});

		// Record the stream to a local file?
		if (RECORD_STREAM) {
			var path = 'recordings/' + Date.now() + '.ts';
			request.socket.recording = fs.createWriteStream(path);
		}
	}
);

// Keep the socket open for streaming
streamServer.headersTimeout = 0;
streamServer.listen(STREAM_PORT);

console.log('Listening for incomming MPEG-TS Stream on https://127.0.0.1:' +
	STREAM_PORT + '/<secret>');
console.log('Awaiting WebSocket connections on wss://127.0.0.1:' +
	WEBSOCKET_PORT + '/');

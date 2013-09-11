var express = require('express');
var middleware = require('../lib/middleware.js');
var bcrypt = require('bcrypt');

// Users
// =====
module.exports = function(db) {

	// Server State
	// ============
	var server = express();
	// Active relays
	// - maps "{username}-{app_domain}-{stream_id}" -> http.ServerResponse
	var _online_relays = {};
	// Active users
	// - maps username -> [{streams:{"foo.com":[123,124],...}, ...]
	var _online_users = {};

	function createRelayId(user, app, stream) {
		return user+'-'+app+'-'+stream;
	}
	function createOnlineUser(userRecord, session) {
		return {
			id: session.user_id,
			streams: {},
			trusted_peers: userRecord.trusted_peers
		};
	}

	// Routes
	// ======

	// Middleware
	// ----------
	server.get('/', middleware.authenticate(db));
	server.all('/:userId', middleware.authenticate(db));

	// Linking
	// -------
	server.all('/', function (req, res, next) {
		// Set links
		res.setHeader('Link', [
			'</>; rel="up via service grimwire.com/-p2pw/service"; title="Grimwire.net P2PW"',
			'</u{?online,trusted}>; rel="self collection grimwire.com/-p2pw/relay grimwire.com/-user"; id="users"',
			'</u/{id}{?stream,nc}>; rel="item grimwire.com/-p2pw/relay grimwire.com/-user"'
		].join(', '));
		next();
	});
	server.all('/:userId', function (req, res, next) {
		// Set links
		var userId = req.params.userId;
		res.setHeader('Link', [
			'</>; rel="via service grimwire.com/-service"; title="Grimwire.net P2PW"',
			'</u{?online,trusted}>; rel="up collection grimwire.com/-user"; id="users"',
			'</u/'+userId+'{?stream,nc}>; rel="self item grimwire.com/-p2pw/relay grimwire.com/-user"; id="'+userId+'"'
		].join(', '));
		next();
	});

	// Get users
	// ---------
	server.head('/', function(req, res) { return res.send(204); });
	server.get('/',
		function(req, res, next) {
			// Content-negotiation
			if (!req.accepts('json')) {
				return res.send(406);
			}

			// Get user's trusted peers, if requested
			if (req.query.trusted) {
				// Get the session user
				db.getUser(res.locals.session.user_id, function(err, dbres) {
					if (err) {
						console.error('Failed to load users from DB', err);
						return res.send(500);
					}
					res.locals.sessionUser = dbres.rows[0];
					res.locals.trusteds = res.locals.sessionUser.trusted_users;
					next();
				});
			} else {
				next();
			}
		},
		function(req, res, next) {
			// Give in-memory online users if requested
			if (req.query.online) {
				res.locals.users = _online_users;
				return next();
			}

			// Load full list from DB
			db.getUsers(function(err, dbres) {
				if (err) {
					console.error('Failed to load users from DB', err);
					return res.send(500);
				}

				res.locals.users = dbres.rows;
				next();
			});
		},
		function(req, res) {
			// Construct output
			var rows = [], users = res.locals.users, trusteds = res.locals.trusteds;
			var sessionUserId = res.locals.session.user_id;
			var shouldFilter = (req.query.trusted && Array.isArray(trusteds));
			var emptyObj = {};
			for (var k in users) {
				var user = users[k];
				// Filter as requested
				if (shouldFilter && trusteds.indexOf(user.id) == -1) {
					continue;
				}
				// Get user's online status
				var onlineUser = _online_users[user.id];
				var isTrusting = (sessionIsTrusted(res.locals.session, onlineUser));
				// Add row
				rows.push({
					id: user.id,
					online: !!onlineUser,
					trusts_this_session: isTrusting,
					streams: (isTrusting) ? onlineUser.streams : emptyObj,
					created_at: user.created_at
				});
			}

			// Send response
			return res.json({ rows: rows });
		}
	);

	// Create user
	// -----------
	server.post('/', function (req, res, next) {
		var session = res.locals.session;
		// Content negotiation
		if (!req.is('json')) {
			return res.send(415);
		}

		// Validate body
		var body = req.body;
		if (!body || !body.id || !body.password) {
			res.writeHead(422, 'bad ent - must include `id` and `password`');
			return res.end();
		}
		if (typeof body.id != 'string' || typeof body.password != 'string') {
			res.writeHead(422, 'bad ent - `id` and `password` must be strings');
			return res.end();
		}
		if (body.email && typeof body.email != 'string') {
			res.writeHead(422, 'bad ent - (when included) `email` must be a string');
			return res.end();
		}

		// Hash the password
		bcrypt.genSalt(10, function(err, salt) {
			bcrypt.hash(body.password, salt, function(err, hash) {
				if (err) {
					console.error('Failed to encrypt user password', err);
					return res.send(500);
				}
				body.password = hash;

				// Try to insert
				db.createUser(body, function(err, dbres) {
					if (err) {
						if (err.code == 23505) { // conflict
							return res.send(409);
						} else {
							console.error('Failed to add user to database', err);
							return res.send(500);
						}
					}

					// Send response
					res.send(204);
				});
			});
		});
	});

	// Get user info or relay stream
	// -----------------------------
	server.head('/:userId', function(req, res) { return res.send(204); });
	server.get('/:userId', function(req, res, next) {
		var session = res.locals.session;

		// JSON request
		if (req.accepts('json')) {

			// :TODO: get user when offline

			// Get user
			var user = _online_users[req.params.userId];
			if (!user) {
				return res.send(404);
			}

			// Check permissions
			if (!sessionIsTrusted(res.locals.session, user)) {
				return res.send(403);
			}

			// Send response
			return res.json({ item: user });
		}

		// Stream request
		if (req.accepts('text/event-stream')) {
			// Only allow users to subscribe to their own relays
			if (req.params.userId != session.user_id) {
				return res.send(403);
			}

			// Store params in response stream
			res.locals.userId   = req.params.userId;
			res.locals.app      = session.app;
			res.locals.streamId = req.query.stream || 0;
			res.locals.relayId  = createRelayId(res.locals.userId, res.locals.app, res.locals.streamId);

			// Check stream availability
			if ((res.locals.relayId in _online_relays)) {
				return res.send(423);
			}

			// Store connection
			return addStream(res, function(err) {
				if (err) {
					return res.send(500);
				}

				// Send back stream header
				res.writeHead(200, 'ok', {
					'content-type': 'text/event-stream',
					'cache-control': 'no-cache',
					'connection': 'keepalive'
				});
				res.write('\n'); // Writing to the stream lets the client know its open
			});
		}

		// Not acceptable
		return res.send(406);
	});

	// Update user/settings
	// --------------------
	server.patch('/:userId', function (req, res, next) {
		var session = res.locals.session;
		// Content negotiation
		if (!req.is('json')) {
			return res.send(415);
		}

		// Only allow users to update their own accounts
		if (req.params.userId != session.user_id) {
			return res.send(403);
		}

		// Validate message
		if (!req.body) {
			return res.send(422, { error: 'Request body is required.' });
		}
		var updates = {};
		if (req.body.trusted_peers) {
			if (!Array.isArray(req.body.trusted_peers) || req.body.trusted_peers.filter(function(v) { return typeof v == 'string'; }).length !== req.body.trusted_peers.length) {
				return res.send(422, { error: '`trusted_peers` must be an array of strings.'});
			}
			updates.trusted_peers = req.body.trusted_peers;
		}
		if (Object.keys(updates).length === 0) {
			return res.send(422, { error: 'No valid fields in the request body.' });
		}

		// Update online user
		var user = _online_users[req.params.userId];
		if (user && updates.trusted_peers) {
			user.trusted_peers = updates.trusted_peers;
		}

		// Update DB
		db.updateUser(req.params.userId, updates, function(err, dbres) {
			if (err) {
				console.error('Failed to update user in DB', err);
				return res.send(500);
			}

			// Send response
			res.send(204);
		});
	});

	// Broadcast to a relay
	// --------------------
	server.post('/:userId', function (req, res, next) {
		var session = res.locals.session;
		// Content negotiation
		if (!req.is('json')) {
			return res.send(415);
		}

		// Only allow users to broadcast via their own relays
		if (req.params.userId != session.user_id) {
			return res.send(403);
		}

		// Validate message
		var body = req.body;
		if (!body || !body.msg || !body.dst || !body.src) {
			return res.send(422, { error: 'Request body must include `msg`, `dst`, and `src`.' });
		}
		body.dst.stream = +body.dst.stream;
		if (typeof body.dst.user != 'string' || typeof body.dst.app != 'string' || isNaN(body.dst.stream)) {
			return res.send(422, { error: '`dst` must include `user` (string), `app` (string), and `stream` (number).' });
		}
		body.src.stream = +body.src.stream;
		if (typeof body.src.user != 'string' || typeof body.src.app != 'string' || isNaN(body.src.stream)) {
			return res.send(422, { error: '`src` must include `user` (string), `app` (string), and `stream` (number).' });
		}
		if (body.src.user != session.user_id || body.src.app != session.app) {
			return res.send(422, { error: '`src.user` and `src.app` must match the sending application (your session shows '+session.user_id+' and '+session.app+')' });
		}

		// Make sure the target relay is online
		var relayId = createRelayId(body.dst.user, body.dst.app, body.dst.stream);
		if (!(relayId in _online_relays)) {
			return res.send(504);
		}

		// Check permissions
		var user = _online_users[body.dst.user];
		if (!sessionIsTrusted(res.locals.session, user)) {
			return res.send(403);
		}

		// Broadcast event to the stream owner
		var data = {
			src: body.src,
			dst: body.dst,
			msg: body.msg
		};
		msg = 'event: signal\r\n';
		msg += 'data: '+JSON.stringify(data)+'\r\n';
		emitTo(relayId, msg+'\r\n');

		// Send response
		res.send(204);
	});


	// Business Logic
	// ==============
	function sessionIsTrusted(session, user) {
		return (user && (user.id == session.user_id || user.trusted_peers.indexOf(session.user_id) !== -1));
	}


	// Stream Helpers
	// ==============
	function emitTo(relayId, msg) {
		var stream = _online_relays[relayId];
		if (!stream) {
			return false;
		}
		stream.write(msg);
		return true;
	}

	function addUser(session, cb) {
		// Load user record
		db.getUser(session.user_id, function(err, dbres) {
			if (err || !dbres) {
				console.error('Failed to load user from DB', err);
				return cb(err);
			}

			// Add to memory
			_online_users[session.user_id] = createOnlineUser(dbres.rows[0], session);
			cb(null, _online_users[session.user_id]);
		});
	}

	function addStream(res, cb) {
		var app = res.locals.session.app;

		// Track the new stream
		_online_relays[res.locals.relayId] = res;
		res.on('close', onResStreamClosed);

		// Update user/app presence
		var user = _online_users[res.locals.session.user_id];
		if (!user) {
			addUser(res.locals.session, function(err, user) {
				if (err) { return cb(err); }
				if (!user.streams[app]) { user.streams[app] = []; }
				user.streams[app].push(res.locals.streamId);
				cb(null, user);
			});
		} else {
			if (!user.streams[app]) { user.streams[app] = []; }
			user.streams[app].push(res.locals.streamId);
			cb(null, user);
		}
	}

	// - handles stream close by client
	function onResStreamClosed() {
		var res      = this;
		var app      = res.locals.app;
		var streamId = res.locals.streamId;
		var relayId  = res.locals.relayId;

		// Clear connection
		res.removeAllListeners('close');

		// Remove from relays
		delete _online_relays[relayId];

		// Update user/app presence
		var user = _online_users[res.locals.session.user_id];
		if (user && user.streams[app]) {
			user.streams[app] = user.streams[app].filter(function(sid) { return sid != streamId; });
			// Remove app from streams of empty
			if (user.streams[app].length === 0) {
				delete user.streams[app];
			}
			// Remove user if there are no active streams
			if (Object.keys(user.streams).length === 0) {
				delete _online_users[res.locals.session.user_id];
			}
		}
	}

	return server;
};
// Page state
// ==========
var _session = null, _session_;
var _users = {};


// Backend Interop
// ===============

// APIs
var serviceAPI = local.navigator('nav:||'+window.location.origin+'|self+grimwire.com/-p2pw/service');
var usersAPI   = serviceAPI.follow({ rel: 'grimwire.com/-user collection' });
var sessionAPI = serviceAPI.follow({ rel: 'grimwire.com/-session' });

// Load session
_session_ = sessionAPI.get({ accept: 'application/json' });
_session_.then(setSession);
function setSession(res) {
	// Update state
	_session = res.body;

	// Update UI
	$('#userid').html(_session.user_id+' <b class="caret"></b>');
	renderAll();
}

// Load active users
function loadActiveUsers() {
	usersAPI.get({ accept: 'application/json' })
		.then(
			function(res) {
				_users = res.body.rows;
				renderAll();
			},
			handleFailedRequest
		);
	return false;
	// ^ loadActiveUsers() is sometimes used as a DOM event handler
}
loadActiveUsers();

// Users refresh on tab focus
(function() {
	var lastRefresh = Date.now();
	window.onfocus = function() {
		if (Date.now() - lastRefresh > 60000) {
			loadActiveUsers();
			lastRefresh = Date.now();
		}
	};
})();

// Request error handling
function handleFailedRequest(res) {
	if (res.status == 401) {
		// session lost
		alert('Your session has expired, redirecting you to the login page.');
		window.location.reload();
	}
}

// UI
// ==

// Cache selectors
var $user_and_friends = $('#user-and-friends');
var $active_users = $('#active-users');

// Logout link
$('#logout').on('click', function(e) {
	sessionAPI.delete()
		.then(window.location.reload.bind(window.location), function() {
			console.warn('Failed to delete session');
		});
	return false;
});

// Refresh button
$('.refresh').on('click', loadActiveUsers);

// Add friend button
$('.add-friend').on('click', function(e) {
	var friend = prompt('User to add to your friends:');
	if (friend && _session.friends.indexOf(friend) === -1) {
		// Update the user
		_session.friends.push(friend);
		usersAPI.follow({ rel: 'item', id: _session.user_id })
			.patch({ friends: _session.friends });

		// Update UI
		renderAll();
	}
});

// Avatars
(function() {
	var arr=[];
	var nAvatars = _avatars.length;
	$('.avatars').html(
		_avatars.sort().map(function(avatar, i) {
			// Add the avatar to the array
			arr.push('<a href="javascript:void(0)" data-avatar="'+avatar+'"><img src="/img/avatars/'+avatar+'" title="'+avatar+'" /></a>');
			// Flush the array on every 8th (or the last)
			if (arr.length === 8 || i === nAvatars-1) {
				var str = '<li>'+arr.join('')+'</li>';
				arr.length = 0;
				return str;
			}
			return '';
		}).join('')
	);
})();
$('.avatars a').on('click', function() {
	var avatar = $(this).data('avatar');

	// Update UI
	$('.avatars a.selected').removeClass('selected');
	$(this).addClass('selected');
	$('.user-avatar').attr('src', '/img/avatars/'+avatar);

	// Update the user
	usersAPI.follow({ rel: 'item', id: _session.user_id })
		.patch({ avatar: avatar });
	_session.avatar = avatar;

	return false;
});

// Rendering helpers
function renderLinkRow(link) {
	var app = link.app;
	return '<tr><td>'+(link.title||link.href)+'<a class="pull-right" href="//'+app+'" target="_blank">'+app+'</a></td></tr>';
}
function renderLinks(userId) {
	return (_users[userId]) ? local.queryLinks(_users[userId].links, { rel: 'grimwire.com/-app' }).map(renderLinkRow).join('') : '';
}

// Update UI state
function renderAll() {
	var html;

	if (_session && Object.keys(_users).length > 0) {
		// Set active avatar
		$('.avatars a[data-avatar="'+_session.avatar+'"]').addClass('selected');

		// Session user
		html = '<h3><img class="user-avatar" src="/img/avatars/'+_session.avatar+'" /> '+_session.user_id+' <small>this is you!</small></h3>';
		html += '<table id="'+_session.user_id+'-links" class="table table-hover table-condensed">'+renderLinks(_session.user_id)+'</table>';

		// Friends
		_session.friends.forEach(function(friendId) {
			var friend = _users[friendId];
			if (!friend) { return; }
			html += '<h4><img src="/img/avatars/'+friend.avatar+'" /> '+friendId;
			html += ' <small><a class="remove-friend" data-user="'+friendId+'" href="javascript:void(0)" title="Remove friend">&times;</a>';
			if (!friend.online) {
				html += ' offline</small></h4>';
			} else {
				html += '</small></h4>';
				html += '<table id="'+friendId+'-links" class="table table-hover table-condensed">' + renderLinks(friendId) + '</table>';
			}
		});

		// Render
		$user_and_friends.html(html);
	} else {
		$user_and_friends.html('');
	}

	// Populate active users
	html = '';
	for (var id in _users) {
		var user = _users[id];
		if (user.online) {
			var apps = [];
			for (var i=0; i < user.links.length; i++) {
				if (apps.indexOf(user.links[i].app) == -1)
					apps.push(user.links[i].app);
			}
			apps = apps.map(function(app) { return '<a href=//'+app+' target=_blank>'+app+'</a><br/>'; }).join('');
			html += '<a class="active-peer" href="#" data-content="'+apps+'">'+user.id+'</a> ';
		} else {
			html += '<span class="text-muted">'+user.id+'</span> ';
		}
	}
	if (!html) { html = '<span class="text-muted">No users online.</span>'; }
	$active_users.html(html);

	// Create popovers
	$('.active-peer').popover({
		html: true,
		placement: 'bottom'
	});

	// Remove friend button
	$('.remove-friend').on('click', function(e) {
		var userId = $(this).data('user');
		if (userId && _session.friends.indexOf(userId) !== -1) {
			// Update the user
			_session.friends.splice(_session.friends.indexOf(userId), 1);
			usersAPI.follow({ rel: 'item', id: _session.user_id })
				.patch({ friends: _session.friends });

			// Update UI
			renderAll();
		}
	});
}
renderAll();
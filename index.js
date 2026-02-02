"use strict"

var maxPlaylists = 1000
var maxPlaylistsToDisplay = 1000
var credentials = null

var totalTracks = 0
var totalPlaylistCount = 0

var abortFetching = false
var popNormalize = false

var allPlaylists = []
var topTracks = null
var allTracks = {}

// =====================
// UI helpers
// =====================
function error (s) {
  info(s)
}

function info (s) {
  $("#info").text(s)
}

// =====================
// Spotify API helpers
// =====================
// Always load the latest credentials from localStorage before making calls,
// so we don't rely on a stale global variable.
function loadCredentials () {
  if ('credentials' in localStorage) {
    try {
      credentials = JSON.parse(localStorage.credentials)
    } catch (e) {
      credentials = null
    }
  }
  return credentials
}

function callSpotify (url, data) {
  loadCredentials()
  return $.ajax(url, {
    dataType: 'json',
    data: data,
    headers: {
      'Authorization': 'Bearer ' + credentials.token
    }
  })
}

function postSpotify (url, json, callback) {
  loadCredentials()
  $.ajax(url, {
    type: "POST",
    data: JSON.stringify(json),
    dataType: 'json',
    headers: {
      'Authorization': 'Bearer ' + credentials.token,
      'Content-Type': 'application/json'
    },
    success: function (r) {
      callback(true, r)
    },
    error: function (r) {
      // 2XX status codes are good, but some have no
      // response data which triggers the error handler
      // convert it to goodness.
      if (r.status >= 200 && r.status < 300) {
        callback(true, r)
      } else {
        callback(false, r)
      }
    }
  })
}

// =====================
// Small playlist helper (convert to web URL)
// =====================
function playlistWebUrl (item) {
  if (!item) return '#'
  // Prefer external_urls.spotify if available
  if (item.external_urls && item.external_urls.spotify) return item.external_urls.spotify
  // If item.uri is like spotify:playlist:<id>, convert it
  if (item.uri && typeof item.uri === 'string' && item.uri.indexOf('spotify:playlist:') === 0) {
    return item.uri.replace(/^spotify:playlist:/, 'https://open.spotify.com/playlist/')
  }
  // fallback to constructing from id
  if (item.id) return 'https://open.spotify.com/playlist/' + item.id
  return '#'
}

// =====================
// Spotify PKCE Auth (SPA)
// =====================

function getTime () {
  return Math.round(new Date().getTime() / 1000)
}

function getSpotifyConfig () {
  var client_id = 'ab78622f8f3448928104b80993cb6eae' // <-- replace with your own
  var redirect_uri = 'https://micscala.github.io/playlistminer/'
  var scopes = 'playlist-modify-public'

  if (document.location.hostname === 'localhost') {
    redirect_uri = 'http://localhost:8000/index.html'
  }

  return { client_id: client_id, redirect_uri: redirect_uri, scopes: scopes }
}

function generateCodeVerifier (length) {
  var possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~'
  var text = ''
  var values = new Uint8Array(length)
  window.crypto.getRandomValues(values)
  for (var i = 0; i < length; i++) {
    text += possible[values[i] % possible.length]
  }
  return text
}

async function generateCodeChallenge (codeVerifier) {
  var data = new TextEncoder().encode(codeVerifier)
  var digest = await window.crypto.subtle.digest('SHA-256', data)
  var base64 = btoa(String.fromCharCode.apply(null, Array.from(new Uint8Array(digest))))
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function buildAuthUrl (config, code_challenge, state) {
  var authUrl = new URL('https://accounts.spotify.com/authorize')
  authUrl.searchParams.set('client_id', config.client_id)
  authUrl.searchParams.set('response_type', 'code')
  authUrl.searchParams.set('redirect_uri', config.redirect_uri)
  authUrl.searchParams.set('scope', config.scopes)
  authUrl.searchParams.set('code_challenge_method', 'S256')
  authUrl.searchParams.set('code_challenge', code_challenge)
  authUrl.searchParams.set('state', state)
  return authUrl.toString()
}

// Replaces old Implicit Grant loginWithSpotify()
async function loginWithSpotify () {
  var config = getSpotifyConfig()

  var code_verifier = generateCodeVerifier(64)
  var code_challenge = await generateCodeChallenge(code_verifier)

  localStorage.setItem('spotify_code_verifier', code_verifier)

  // anti-CSRF state
  var state = (window.crypto && window.crypto.randomUUID) ? window.crypto.randomUUID() : String(Math.random())
  localStorage.setItem('spotify_auth_state', state)

  var url = buildAuthUrl(config, code_challenge, state)
  document.location = url
}

async function exchangeCodeForToken (code) {
  var config = getSpotifyConfig()
  var code_verifier = localStorage.getItem('spotify_code_verifier')

  if (!code_verifier) {
    throw new Error('Missing PKCE code_verifier in localStorage')
  }

  var body = new URLSearchParams()
  body.set('client_id', config.client_id)
  body.set('grant_type', 'authorization_code')
  body.set('code', code)
  body.set('redirect_uri', config.redirect_uri)
  body.set('code_verifier', code_verifier)

  var res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString()
  })

  if (!res.ok) {
    var errText = await res.text()
    throw new Error('Token exchange failed: ' + errText)
  }

  return await res.json() // { access_token, expires_in, refresh_token?, token_type }
}

async function refreshAccessTokenIfPossible () {
  loadCredentials()
  if (!credentials || !credentials.refresh_token) {
    return false
  }

  var config = getSpotifyConfig()

  var body = new URLSearchParams()
  body.set('client_id', config.client_id)
  body.set('grant_type', 'refresh_token')
  body.set('refresh_token', credentials.refresh_token)

  var res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString()
  })

  if (!res.ok) {
    return false
  }

  var data = await res.json()
  credentials.token = data.access_token
  credentials.expires = getTime() + parseInt(data.expires_in || 3600, 10)
  if (data.refresh_token) {
    credentials.refresh_token = data.refresh_token
  }

  localStorage['credentials'] = JSON.stringify(credentials)
  return true
}

// Replaces old performAuthDance() (no more parsing location.hash)
async function performAuthDance () {
  // 1) use stored credentials if still valid
  loadCredentials()
  if (credentials && credentials.expires > getTime()) {
    $("#search-form").show()
    return
  }

  // 2) if expired, try refresh (only works if refresh_token exists)
  if (credentials && credentials.expires <= getTime()) {
    var refreshed = await refreshAccessTokenIfPossible()
    if (refreshed) {
      $("#search-form").show()
      return
    }
  }

  // 3) handle Spotify callback with ?code=...
  var params = new URLSearchParams(window.location.search)
  var code = params.get('code')
  var returnedState = params.get('state')
  var errorParam = params.get('error')

  if (errorParam) {
    error("Spotify auth error: " + errorParam)
    $("#login-form").show()
    return
  }

  if (code) {
    var expectedState = localStorage.getItem('spotify_auth_state')
    if (expectedState && returnedState !== expectedState) {
      error("State mismatch during Spotify authentication.")
      $("#login-form").show()
      return
    }

    try {
      var tokenData = await exchangeCodeForToken(code)

      credentials = {
        token: tokenData.access_token,
        expires: getTime() + parseInt(tokenData.expires_in || 3600, 10)
      }
      if (tokenData.refresh_token) {
        credentials.refresh_token = tokenData.refresh_token
      }

      // Fetch user profile to store user_id like before
      callSpotify('https://api.spotify.com/v1/me').then(
        function (user) {
          credentials.user_id = user.id
          localStorage['credentials'] = JSON.stringify(credentials)

          // Clean the URL (remove ?code=...&state=...)
          window.history.replaceState({}, document.title, window.location.pathname)

          $("#search-form").show()
        },
        function () {
          error("Can't get user info")
          $("#login-form").show()
        }
      )

    } catch (e) {
      error(e.message || String(e))
      $("#login-form").show()
    }
    return
  }

  // 4) otherwise, show login
  $("#login-form").show()
}

// =====================
// App logic (unchanged except sorting and web links)
// =====================

function findMatchingPlaylists (text) {
  var outstanding = 0

  // Accumulate all playlists across all pages, then sort/render once
  var gatheredPlaylists = []
  var gatheredTotal = null

  function addItem (tbody, which, item) {
    if (!(item?.tracks)) {
      return // skip broken / unavailable playlists
    }

    // Web link (preferred) -> external_urls.spotify, else convert spotify:playlist: to open.spotify.com
    var webUrl = '#'
    if (item?.external_urls?.spotify) {
      webUrl = item.external_urls.spotify
    } else if (typeof item?.uri === 'string' && item.uri.indexOf('spotify:playlist:') === 0) {
      webUrl = item.uri.replace(/^spotify:playlist:/, 'https://open.spotify.com/playlist/')
    } else if (item?.id) {
      webUrl = 'https://open.spotify.com/playlist/' + item.id
    }

    var tr = $("<tr>")
    var rowNumber = $("<td>").text(which)
    var title = $("<td>").append(
      $("<a>")
        .attr('href', webUrl)
        .attr('target', '_blank')
        .text(item?.name)
    )
    var tracks = $("<td>").text(item?.tracks?.total)

    tr.append(rowNumber)
    tr.append(title)
    tr.append(tracks)
    tbody.append(tr)
  }

  function finalizeAndRender () {
    var tbody = $("#playlist-items")

    // Global sort by number of tracks (descending)
    gatheredPlaylists.sort(function (a, b) {
      return (b?.tracks?.total || 0) - (a?.tracks?.total || 0)
    })

    // Clear table + reset downstream state, then repopulate in sorted order
    tbody.empty()
    allPlaylists = []
    totalTracks = 0

    var displayCount = Math.min(gatheredPlaylists.length, maxPlaylistsToDisplay)
    for (var i = 0; i < displayCount; i++) {
      var item = gatheredPlaylists[i]
      addItem(tbody, i + 1, item)

      // Keep collecting for track fetching
      if (allPlaylists.length < maxPlaylists) {
        if (item?.tracks?.total) {
          allPlaylists.push([item?.owner?.id || '', item?.id || ''])
          totalTracks += item?.tracks?.total || 0
        }
      }
    }

    $(".total-tracks").text(totalTracks)
    $(".total-playlists").text(allPlaylists.length)

    if (allPlaylists.length > 0) {
      $('#fetch-tracks-ready').show(200)
    } else {
      info("No matching playlists found")
      $('#fetch-tracks-ready').show(200)
    }
  }

  function showSearchResults (data) {
    outstanding--

    if (gatheredTotal === null) {
      gatheredTotal = Math.min(data.playlists.total, maxPlaylists)
    }

    var matching = data.playlists.total > maxPlaylists ? ">" + maxPlaylists : data.playlists.total
    $("#matching").text(matching)

    // Collect usable items from this page
    if (Array.isArray(data.playlists.items)) {
      _.each(data.playlists.items, function (item) {
        if (item && item.tracks && typeof item.tracks.total === 'number') {
          gatheredPlaylists.push(item)
        }
      })
    }

    // Update progress based on how many we have gathered so far
    var collected = Math.min(gatheredPlaylists.length, gatheredTotal || gatheredPlaylists.length)
    var percentComplete = gatheredTotal ? Math.round(collected * 100 / gatheredTotal) : 0
    $("#playlist-progress").css('width', percentComplete + "%")

    // When all requests complete (or user aborts), render once globally sorted
    if (abortFetching || outstanding === 0) {
      abortFetching = false
      finalizeAndRender()
    }
  }

  function processPlaylistError () {
    outstanding--
    error("Can't get playlists")
    if (abortFetching || outstanding === 0) {
      abortFetching = false
      finalizeAndRender()
    }
  }

  function processPlaylists (data) {
    var total = Math.min(data.playlists.total, maxPlaylists)
    var offset = data.playlists.offset + data.playlists.items.length
    for (var i = offset; i < total; i += 50) {
      var url = 'https://api.spotify.com/v1/search'
      var params = {
        q: text,
        type: 'playlist',
        limit: data.playlists.limit,
        offset: i
      }
      outstanding++
      callSpotify(url, params).then(showSearchResults, processPlaylistError)
    }
    showSearchResults(data)
  }

  // Reset state
  totalTracks = 0
  abortFetching = false
  allPlaylists = []
  gatheredPlaylists = []
  gatheredTotal = null
  $('#fetch-tracks-ready').hide()

  var url = 'https://api.spotify.com/v1/search'
  var params = {
    q: text,
    type: 'playlist',
    limit: 50
  }
  $("#playlist-items").empty()
  $("#playlist-progress").css('width', "0%")

  outstanding++
  callSpotify(url, params).then(processPlaylists, processPlaylistError)
}


function go () {
  $("#top").hide(200)
  var text = $("#playlist-terms").val()
  if (text.length > 0) {
    info("")
    $(".keywords").text(text)
    $(".results").hide()
    $("#playlist-table").show()
    findMatchingPlaylists(text)
  } else {
    info("Enter some keywords first")
  }
}

function new_getTrackScore (track) {
  if (popNormalize) {
    var factor = track.popularity > 30 ? track.popularity : 30
    factor = factor * factor
    var score = 1000. * track.count / factor
    return score
  } else {
    return track.count
  }
}

function getTrackScore (track) {
  return new_getTrackScore(track)
}

function refreshTrackList (allTracks) {
  info("")

  var tracks = []
  _.each(allTracks, function (track, id) {
    track.score = getTrackScore(track)
    tracks.push(track)
  })
  tracks.sort(function (a, b) {
    return b.score - a.score
  })

  topTracks = tracks.slice(0, 100)
  var table = $("#track-items")
  var newRows = []
  _.each(topTracks, function (track, i) {
    var tr = $("<tr>")
    tr.append($("<td>").text(i + 1))
    tr.append($("<td>").append($("<a>").attr('href', track.uri).text(track.name)))
    tr.append($("<td>").text(track.artists[0].name))
    tr.append($("<td>").text(Math.round(track.score)))
    newRows.push(tr)
  })
  table.empty().append(newRows)
}

function saveTidsToPlaylist (playlist, tids) {
  var url = "https://api.spotify.com/v1/users/" + playlist.owner.id +
    "/playlists/" + playlist.id + '/tracks'

  postSpotify(url, { uris: tids }, function (ok, data) {
    if (ok) {
      info("Playlist saved")
      $("#ready-to-save").hide(100)
      $("#playlist-name").attr('href', playlist.uri)
    } else {
      error("Trouble saving to the playlist")
    }
  })
}

function savePlaylist () {
  var title = getPlaylistTitle()
  var tids = []

  _.each(topTracks, function (track, i) {
    tids.push(track.uri)
  })

  var url = "https://api.spotify.com/v1/users/" + credentials.user_id + "/playlists"
  var json = { name: title }

  postSpotify(url, json, function (ok, playlist) {
    if (ok) {
      saveTidsToPlaylist(playlist, tids)
    } else {
      error("Can't create the new playlist")
    }
  })
}

function getPlaylistTitle () {
  return "Top " + $("#playlist-terms").val() + " tracks"
}

function fetchAllTracksFromPlaylist () {
  var start = new Date().getTime()
  $(".results").hide()
  $("#track-table").show()
  $("#ready-to-save").hide()
  $("#fetching-tracks").show()

  allTracks = {}

  var queue = allPlaylists.slice(0)
  var totalTracks = 0
  totalPlaylistCount = 0

  function isGoodPlaylist (items) {
    var albums = {}
    var artists = {}

    _.each(items, function (item) {
      if (item.track) {
        var track = item.track
        var rid = track.album.id
        var aid = track.artists[0].id
        albums[rid] = rid
        artists[aid] = aid
      }
    })
    return Object.keys(albums).length > 1 && Object.keys(artists).length > 1
  }

  function doneFetching () {
    abortFetching = false
    $("#fetching-tracks").hide(100)
    if (topTracks.length == 0) {
      info("No matching tracks found")
    } else {
      $("#ready-to-save").show()
    }
    var end = new Date().getTime()
    var total = end - start
    console.log('delta time', total, 'len',
      allPlaylists.length, 'per 1000', Math.round(total / allPlaylists.length))
  }

  var outstanding = 0
  var maxSimultaneous = 10

  function fetchNextTracksFromPlaylist () {
    while (!abortFetching && queue.length > 0 && outstanding < maxSimultaneous) {
      var tinfo = queue.pop(0)
      var user = tinfo[0]
      var pid = tinfo[1]

      var url = "https://api.spotify.com/v1/users/"
        + user + "/playlists/" + pid + "/tracks"
      outstanding++
      callSpotify(url).then(
        function (data) {
          var remaining = outstanding + queue.length
          var progress = Math.round(100.0 - (100.0 * remaining / allPlaylists.length))

          $("#track-progress").css('width', progress + "%")
          $("#tt-total-tracks").text(totalTracks)
          $("#tt-unique-tracks").text(Object.keys(allTracks).length)
          if (isGoodPlaylist(data.items)) {
            totalPlaylistCount += 1
            _.each(data.items, function (item, i) {
              var count = i == 0 ? 3 : i <= 2 ? 1 : 1
              if (item.track) {
                if (item.track.id) {
                  if (!(item.track.id in allTracks)) {
                    allTracks[item.track.id] = item.track
                    allTracks[item.track.id].count = 0
                  }
                  allTracks[item.track.id].count += count
                  totalTracks += 1
                }
              }
            })
          } else {
          }

          refreshTrackList(allTracks)

          --outstanding
          if (outstanding <= 0 && (abortFetching || queue.length == 0)) {
            doneFetching()
          } else {
            fetchNextTracksFromPlaylist()
          }
        },

        function () {
          error("trouble fetching tracks")
          --outstanding
          if (outstanding <= 0 && (abortFetching || queue.length == 0)) {
            doneFetching()
          } else {
            fetchNextTracksFromPlaylist()
          }
        }
      )
    }
  }
  fetchNextTracksFromPlaylist()
}

function initApp () {
  $(".intro-form").hide()
  $(".results").hide()
  $("#playlist-terms").keyup(
    function (event) {
      if (event.keyCode == 13) {
        go()
      }
    }
  )
  $("#go").on('click', function () {
    go()
  })

  $(".stop-button").on('click', function () {
    abortFetching = true
  })

  $("#fetch-tracks").on('click', function () {
    fetchAllTracksFromPlaylist()
  })

  $("#login-button").on('click', function () {
    loginWithSpotify()
  })
  $("#save-button").on('click', function () {
    savePlaylist()
  })

  $("#norm-for-pop").on('click', function () {
    popNormalize = $("#norm-for-pop").is(':checked')
    refreshTrackList(allTracks)
  })
}

$(document).ready(function () {
  initApp()
  // performAuthDance is async now
  performAuthDance()
})

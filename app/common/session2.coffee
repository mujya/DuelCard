debug = require('debug')('session')
{EventEmitter} = require 'events'
Promise = require 'bluebird'
Firebase = require 'firebase'
fetch = require 'isomorphic-fetch'
moment = require 'moment'
Storage = require('app/common/storage')
i18next = require('i18next')

class Session extends EventEmitter

  constructor: (options = {}) ->
    @url = process.env.API_URL || options.url || 'http://localhost:5000'
    @fbUrl = process.env.FIREBASE_URL || options.fbUrl || 'https://duelyst-development.firebaseio.com/'
    debug("constructor: #{@url} : #{@fbUrl}")
    # init props for reference
    @fbRef = null
    @token = null
    @expires = null
    @firebaseRefreshToken = null
    @_firebaseTokenRefreshTimer = null
    @userId = null
    @username = null
    @analyticsData = null
    @justRegistered = null
    @_cachedPremiumBalance = null
    return

  _checkResponse: (res) ->
    if res.ok
      debug("_checkResponse: #{res.status}")
      return res.json()
      .then (data) ->
        data.status = res.status
        return data
    else
      err = new Error(res.statusText)
      err.status = res.status
      if res.status == 400 || res.status == 401
        return res.json().then (data) =>
          err.innerMessage = if data.codeMessage then data.codeMessage else data.message
          debug("_checkResponse: #{res.status} : #{err.message} : #{err.innerMessage}")
          @emit 'error', err
          throw err
      else
        err.innerMessage = 'Please try again'
        debug("_checkResponse: #{res.status} : #{err.message}")
        @emit 'error', err
        throw err

  _networkError: (e) ->
    debug("_networkError: #{e.message}")
    throw new Error('Please try again')

  # The server mints a short-lived Firebase custom token. The legacy Firebase
  # SDK cannot consume custom tokens directly, but the Realtime Database
  # accepts ID tokens - so exchange the custom token for an ID token over the
  # Identity Toolkit REST API and hand that to authWithCustomToken.
  _authFirebase: (firebaseToken) ->
    debug('authFirebase')
    if not firebaseToken?
      return Promise.reject(new Error('missing firebase token'))
    apiKey = process.env.FIREBASE_API_KEY
    if not apiKey
      return Promise.reject(new Error('missing FIREBASE_API_KEY'))
    return Promise.resolve(
      fetch "https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=#{apiKey}",
        method: 'POST'
        headers:
          'Content-Type': 'application/json'
        body: JSON.stringify({token: firebaseToken, returnSecureToken: true})
    )
    .then (res) ->
      return res.json().then (body) ->
        if not res.ok
          err = new Error((body.error and body.error.message) || "Firebase sign-in failed (#{res.status})")
          err.code = body.error and body.error.code
          throw err
        return body
    .then (data) =>
      @firebaseRefreshToken = data.refreshToken
      @_scheduleFirebaseTokenRefresh(parseInt(data.expiresIn, 10) or 3600)
      return @_authWithIdToken(data.idToken)

  _authWithIdToken: (idToken) ->
    return new Promise (resolve, reject) =>
      @fbRef = new Firebase(@fbUrl)
      @fbRef.authWithCustomToken idToken, (err, auth) ->
        if err then return reject(err)
        resolve(auth)

  # ID tokens live for about an hour; re-sign before they expire so a long
  # session does not start failing with permission denied.
  _scheduleFirebaseTokenRefresh: (expiresInSeconds) ->
    @_clearFirebaseTokenRefresh()
    delay = Math.max((expiresInSeconds - 300) * 1000, 60 * 1000)
    @_firebaseTokenRefreshTimer = setTimeout(
      () => @_refreshFirebaseToken()
      delay
    )
    return

  _clearFirebaseTokenRefresh: () ->
    if @_firebaseTokenRefreshTimer?
      clearTimeout(@_firebaseTokenRefreshTimer)
      @_firebaseTokenRefreshTimer = null
    return

  _refreshFirebaseToken: () ->
    if not @firebaseRefreshToken?
      return Promise.resolve(null)
    apiKey = process.env.FIREBASE_API_KEY
    return Promise.resolve(
      fetch "https://securetoken.googleapis.com/v1/token?key=#{apiKey}",
        method: 'POST'
        headers:
          'Content-Type': 'application/x-www-form-urlencoded'
        body: "grant_type=refresh_token&refresh_token=#{encodeURIComponent(@firebaseRefreshToken)}"
    )
    .then (res) ->
      if not res.ok then throw new Error("Firebase token refresh failed (#{res.status})")
      return res.json()
    .then (data) =>
      @firebaseRefreshToken = data.refresh_token
      @_scheduleFirebaseTokenRefresh(parseInt(data.expires_in, 10) or 3600)
      return @_authWithIdToken(data.id_token)
    .catch (e) ->
      debug("refreshFirebaseToken failed: #{e.message}")
      return null

  _deauthFirebase: () ->
    debug('deauthFirebase')
    if @userId and @fbRef
      @fbRef
      .child("users")
      .child(@userId)
      .child("presence")
      .update({
        status: "offline"
        ended: Firebase.ServerValue.TIMESTAMP
      })
    @_clearFirebaseTokenRefresh()
    @firebaseRefreshToken = null
    if @fbRef?
      @fbRef.unauth()
    return

  ###
    Show url for purchasing premium currency on external site
  ###
  initPremiumPurchase: () ->
    return Promise.resolve("")

  login: (username, password, silent = false) ->
    debug("login: #{username}")

    body = {}
    body.password = password
    body.username = username

    return Promise.resolve(
      fetch "#{@url}/session",
        method: 'POST'
        headers:
          'Accept': 'application/json'
          'Content-Type': 'application/json'
        body: JSON.stringify(body)
    )
    .bind(this)
    .timeout(10000)
    .catch(@_networkError)
    .then (@_checkResponse)
    .then (res) =>
      @analyticsData = res.analytics_data
      @token = res.token
      @userId = res.user_id
      @username = res.username
      # Exchange the server's Firebase custom token for a database session.
      return @_authFirebase(res.firebase_token)
    .then () =>
      data = {token: @token, userId: @userId, analyticsData:@analyticsData}
      if !silent
        @emit 'login', data
      return data

  logout: () ->
    debug('logout')

    # if @userId
      # @_deauthFirebase()

    if @token
      fetch "#{@url}/session/logout",
        method: 'GET'
        headers:
          'Accept': 'application/json'
          'Content-Type': 'application/json'
          'Authorization': "Bearer #{@token}"
      .catch () ->

    @_clearFirebaseTokenRefresh()
    @firebaseRefreshToken = null
    @fbRef = null
    @token = null
    @expires = null
    @userId = null
    @username = null
    @analyticsData = null

    # clear storage
    @emit 'logout'

  register: (opts) ->
    debug("register #{JSON.stringify(opts)}")

    opts.is_desktop = window.isDesktop || false

    return Promise.resolve(
      fetch "#{@url}/session/register",
        method: 'POST'
        headers:
          'Accept': 'application/json'
          'Content-Type': 'application/json'
        body: JSON.stringify(opts)
    )
    .bind(this)
    .timeout(10000)
    .catch(@_networkError)
    .then (@_checkResponse)
    .then (data) =>
      debug data
      @justRegistered = true
      @emit 'registered'
      return {username: opts.username, password: opts.password}

  isUsernameAvailable: (username) ->
    return Promise.resolve(
      fetch "#{@url}/session/username_available",
        method: 'POST'
        headers:
          'Accept': 'application/json'
          'Content-Type': 'application/json'
        body: JSON.stringify({username: username})
    )
    .then (res) ->
      # available
      if res.ok then return true
      # 401 result suggests username is bad or unavailable
      if res.status == 401 then return false
      # all other results suggest server is unavailable or had an error
      # so assume username is valid and let the server handle it in the later registration request
      return true
    .catch (e) ->
      debug("isUsernameAvailable #{e.message}")
      return true

  changeUsername: (new_username) ->
    return Promise.resolve(
      fetch "#{@url}/session/change_username",
        method: 'POST'
        headers:
          'Accept': 'application/json'
          'Content-Type': 'application/json'
          'Authorization': "Bearer #{@token}"
        body: JSON.stringify({new_username: new_username})
    )
    .bind(this)
    .timeout(10000)
    .catch(@_networkError)
    .then(@_checkResponse)
    .then (data) =>
      @username = new_username
      if data?.firebase_token?
        return @_authFirebase(data.firebase_token)

  changePassword: (currentPassword, new_password) ->
    return Promise.resolve(
      fetch "#{@url}/session/change_password",
        method: 'POST'
        headers:
          'Accept': 'application/json'
          'Content-Type': 'application/json'
          'Authorization': "Bearer #{@token}"
        body: JSON.stringify({
          current_password: currentPassword,
          new_password: new_password
        })
    )
    .bind(this)
    .timeout(5000)
    .catch(@_networkError)
    .then(@_checkResponse)

  changePortrait: (portraitId) ->
    if !portraitId?
      return Promise.reject(new Error("Invalid portrait!"))

    return Promise.resolve(
      fetch "#{@url}/api/me/profile/portrait_id",
        method: 'PUT'
        headers:
          'Accept': 'application/json'
          'Content-Type': 'application/json'
          'Authorization': "Bearer #{@token}"
        body: JSON.stringify({portrait_id: portraitId})
    )
    .bind(this)
    .timeout(5000)
    .catch(@_networkError)
    .then(@_checkResponse)

  changeBattlemap: (battlemapId) ->
    return Promise.resolve(
      fetch "#{@url}/api/me/profile/battle_map_id",
        method: 'PUT'
        headers:
          'Accept': 'application/json'
          'Content-Type': 'application/json'
          'Authorization': "Bearer #{@token}"
        body: JSON.stringify({battle_map_id: battlemapId})
    )
    .bind(this)
    .timeout(5000)
    .catch(@_networkError)
    .then(@_checkResponse)

  isAuthenticated: (token) ->
    if not token? then return Promise.resolve(false)

    # Validate the API token with our server first. The session endpoint also
    # hands back a fresh Firebase custom token for the database session.
    return Promise.resolve(
      fetch "#{@url}/session",
        method: 'GET'
        headers:
          'Accept': 'application/json'
          'Content-Type': 'application/json'
          'Authorization': "Bearer #{token}"
    )
    .bind(@)
    .timeout(15000)
    .then (res) =>
      debug("isAuthenticated:fetch #{res.ok}")
      if not res.ok then return null
      return @_checkResponse(res)
    .then (data) =>
      if data == null then return false

      @token = token
      @userId = data.user_id
      @username = data.username
      @analyticsData = data.analytics_data
      return @_authFirebase(data.firebase_token)
    .then () =>
      @emit 'login', {token: @token, userId: @userId, analyticsData: @analyticsData}
      return true
    .catch (e) ->
      debug("isAuthenticated:failed #{e.message}")
      return false

  refreshToken: (silent = false) ->
    if not @token? then return Promise.resolve(null)
    return Promise.resolve(
      fetch "#{@url}/session",
        method: 'GET'
        headers:
          'Accept': 'application/json'
          'Content-Type': 'application/json'
          'Authorization': "Bearer #{@token}"
    )
    .bind(@)
    .then (res) =>
      debug("refreshToken:fetch #{res.ok}")
      if not res.ok then return null
      return @_checkResponse(res)
    .then (data) =>
      if data == null then return null
      # override existing token and analytics with new ones
      @token = data.token
      @analyticsData = data.analytics_data
      @userId = data.user_id
      @username = data.username
      return @_authFirebase(data.firebase_token)
    .then () =>
      # emit login event with whatever data we currently have
      if !silent
        @emit 'login', {@token, @analyticsData, @userId}
      return true
    .catch (e) ->
      debug("refreshToken:failed #{e.message}")
      return null

  # Returns whether this is the player's first session of the day based on their last session timestamp
  # Note: this can change during the session if a new day begins
  getIsFirstSessionOfDay: () ->
    # If no analytics data this is being called before auth, shouldn't happen but return false
    if not @.analyticsData?
      return false

    # Having no last_session_at means this is their first session ever
    if not @.analyticsData.last_session_at?
      return true

    startOfTodayMoment = moment.utc().startOf('day')
    lastSessionStartOfDayMoment = moment.utc(@.analyticsData.last_session_at).startOf('day')

    return lastSessionStartOfDayMoment.valueOf() < startOfTodayMoment.valueOf()

  saveToStorage: () ->
    if @token
      Storage.set('token', @token)

  clearStorage: () ->
    Storage.remove('token')

module.exports = new Session()

module.exports.create = (options) ->
  return new Session(options)

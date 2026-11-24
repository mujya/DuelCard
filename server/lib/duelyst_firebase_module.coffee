Promise = require 'bluebird'
firebaseAdmin = require 'firebase-admin'
jwt = require 'jsonwebtoken'
colors = require 'colors'
moment = require 'moment'
util = require 'util'
_ = require 'underscore'
url = require 'url'

Logger = require '../../app/common/logger.coffee'
config = require '../../config/config.js'
defaultFirebaseUrl = config.get('firebase.url')
firebaseLoggingEnabled = config.get('firebase.loggingEnabled')
useLocalRtdb = config.get('firebase.useLocalRtdb')

# Build the Firebase credential (only needed when not using self-hosted LocalRTDB).
firebaseCredential = null
if useLocalRtdb
  Logger.module('Firebase').log 'USE_LOCAL_RTDB=true: using self-hosted Redis + Socket.IO LocalRTDB.'
else
  try
    firebaseServiceAccount = {
      project_id: config.get('firebase.projectId'),
      client_email: config.get('firebase.clientEmail'),
      private_key: config.get('firebase.privateKey'),
    }
    if firebaseServiceAccount.client_email and firebaseServiceAccount.private_key
      if !firebaseServiceAccount.project_id
        throw new Error('FIREBASE_PROJECT_ID must be set!')
      Logger.module('Firebase').log 'Using service account credentials from the environment.'
      firebaseCredential = firebaseAdmin.credential.cert(firebaseServiceAccount)
    else
      Logger.module('Firebase').log 'Using application default credentials (GOOGLE_APPLICATION_CREDENTIALS).'
      firebaseCredential = firebaseAdmin.credential.applicationDefault()
  catch error
    Logger.module('Firebase').error "Failed to read Firebase credentials: #{error}"
    firebaseCredential = null

class DuelystFirebaseModule
  # App objects keyed by URL
  @apps: {}

  # Connect to a Firebase URL, returns connection if already exists
  @connect: (firebaseUrl = defaultFirebaseUrl) ->
    if useLocalRtdb
      key = 'local://rtdb/'
      if @apps[key]?
        return @apps[key]
      @apps[key] = new DuelystFirebaseModule(
        key: key,
        firebaseUrl: key,
      )
      return @apps[key]

    # Check for an existing connection on this URL.
    # TODO: check token expiration, new tokens from callers, etc.
    key = url.format(url.parse(firebaseUrl))
    if @apps[key]?
      return @apps[key]

    # Create a new connection.
    @apps[key] = new DuelystFirebaseModule(
      key: key,
      firebaseUrl: firebaseUrl,
    )

  # Create a Firebase Authentication custom token for the given uid.
  # The token is signed with the service account (RS256), so a client must
  # exchange it for an ID token via the Firebase SDK (signInWithCustomToken).
  # Custom claims are exposed to Realtime Database rules as auth.<claim>.
  @createCustomToken: (uid, claims = {}) ->
    if useLocalRtdb
      secret = config.get('jwt.secretKey')
      if !secret
        return Promise.reject(new Error('TOKEN_SECRET must be set when USE_LOCAL_RTDB=true'))
      payload = _.extend({}, claims, { uid: uid, d: _.extend({ id: uid }, claims) })
      token = jwt.sign(payload, secret, { algorithm: 'HS256', expiresIn: config.get('jwt.tokenExpiration') || '14d' })
      return Promise.resolve(token)

    @connect().promise.then (app) ->
      firebaseAdmin.auth(app).createCustomToken(uid, claims)

  # Gracefully disconnect from Firebase.
  @disconnect: (url) ->
    if @apps[url]?
      Logger.module('Firebase').log "disconnecting from #{url}"
      @apps[url].promise.then (deletable) ->
        deletable.delete().then (error) ->
          Logger.module('Firebase').error "failed to delete: #{error.toString()}"
      delete DuelystFirebaseModule.apps[url]
    else
      Logger.module('Firebase').log "already disconnected from #{url}"

  # Count current number of connections
  @getNumConnections: ->
    _.size(@apps)

  # Opens new connections
  constructor: ({@key, @firebaseUrl}) ->
    Logger.module('Firebase').log "connect() -> new app connection with db #{@key}"
    if useLocalRtdb
      { getStore } = require './local_rtdb/store'
      @promise = Promise.resolve({ database: -> getStore() })
      return

    @promise = new Promise (resolve, reject) =>
      # Validate configuration before attempting to connect.
      if @firebaseUrl == ''
        return reject(new Error('firebase.url must be set'))

      if firebaseLoggingEnabled
        firebaseAdmin.database.enableLogging(true)

      if !firebaseCredential
        return reject(new Error('firebase credentials must be configured'))

      try
        app = firebaseAdmin.initializeApp({
          credential: firebaseCredential,
          databaseURL: @firebaseUrl
        }, @firebaseUrl)

        # Initialize the database before resolving.
        db = app.database()
        ref = db.ref()
        resolve(app)
      catch e
        return reject(new Error('failed to initialize firebase app: ' + e))

    @promise.catch (error) =>
      delete DuelystFirebaseModule.apps[@key]

  # Returns a Promise with the Firebase root reference
  getRootRef: ->
    @promise
    .then (app) ->
      try
        db = app.database()
        return db.ref()
      catch e
        Logger.module('Firebase').error "failed to get ref: #{e.toString()}"

module.exports = DuelystFirebaseModule

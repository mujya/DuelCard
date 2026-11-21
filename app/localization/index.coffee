Promise = require 'bluebird'
i18next = require 'i18next'
XHR = require 'i18next-xhr-backend'
LngDetector = require 'i18next-browser-languagedetector'
Storage = require 'app/common/storage'

options = {
  whitelist: ['en', 'de', 'zh-TW', 'zh-CN'],
  fallbackLng: 'en',
  # only request the exact language file (don't probe the "zh" parent language)
  load: 'currentOnly',
  contextSeparator: '$',
  defaultNS: 'translation',
  backend: {
    loadPath: "resources/locales/{{lng}}/index.json"
  },
  detection: {
    order: ['querystring', 'navigator'],
    lookupQuerystring: 'lng',
    lookupLocalStorage: Storage.namespace() + '.i18nextLng',
  }
}

p = new Promise (resolve, reject) ->

  preferredLanguageKey = Storage.get('preferredLanguageKey')

  # i18next normalises language codes to zh-TW / zh-CN; accept the old lowercase
  # values so a previously stored preference still works.
  if (preferredLanguageKey == 'zh-tw')
    preferredLanguageKey = 'zh-TW'
  else if (preferredLanguageKey == 'zh-cn')
    preferredLanguageKey = 'zh-CN'

  if (preferredLanguageKey)
    options.lng = preferredLanguageKey
  else
    # default language: Simplified Chinese
    options.lng = 'zh-CN'

  i18next
    .use(LngDetector)
    .use(XHR)
    .init options, (err,t)->
      if (err)
        reject(err)
      else
        resolve(t)


module.exports = p

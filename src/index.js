process.env.SENTRY_DSN =
  process.env.SENTRY_DSN ||
  'https://1f3bcbb057c5435da229ff1039b48baf:1d9127715e7c4f728509d22a2bfe99a5@sentry.cozycloud.cc/47'

const {
  CookieKonnector,
  scrape,
  errors,
  log,
  solveCaptcha
} = require('cozy-konnector-libs')

const get = require('lodash/get')

const baseUrl = 'https://www.leclercdrive.fr'

class LeclercConnector extends CookieKonnector {
  async testSession() {
    const resp = await this.request.get(baseUrl, {
      resolveWithFullResponse: true
    })
    const mag = new URL(resp.request.uri.href).searchParams.get('mag')

    if (mag) return mag
    else return false
  }

  async fetch(fields) {
    await this.deactivateAutoSuccessfulLogin()
    this.requestJSON = this.requestFactory({
      cheerio: false,
      json: true
    })

    const mag =
      (await this.testSession()) ||
      (await this.authenticate(fields.login, fields.password))

    await this.notifySuccessfulLogin()

    const magasinURL = await this.fetchMagasinURL(mag)
    const $ = await this.request(magasinURL)
    // get the link to commands
    const commandURL = $(`a[href*='mes-commandes']`)
      .eq(0)
      .attr('href')
    log('info', 'Fetching the list of commands')
    const commands = await this.fetchAndParseCommands(commandURL)
    log('info', 'Fetching details about each command')

    log('info', 'Saving data to Cozy')
    await this.saveBills(commands, fields.folderPath, {
      contentType: 'application/pdf',
      linkBankOperations: false,
      sourceAccount: this.accountId,
      sourceAccountIdentifier: fields.login,
      keys: ['vendorRef'],
      fileIdAttributes: ['vendorRef']
    })
  }

  async solveDataDomeCaptcha(err) {
    log('info', 'solving datadome captcha...')
    let ccid = this._jar
      .getCookies(baseUrl)
      .find(cookie => cookie.key === 'datadome').value
    const websiteURL = err.error.url + '&cid=' + ccid

    const $ = await this.request(websiteURL)
    const formAction = new URLSearchParams(
      $('#human-contact-form')
        .attr('action')
        .split('?')
        .pop()
    )

    const hash = formAction.get('hash')
    const cid = formAction.get('cid')
    const icid = formAction.get('initialCid')

    const websiteKey = '6LccSjEUAAAAANCPhaM2c\u002DWiRxCZ5CzsjR_vd8uX'
    const captchaToken = await solveCaptcha({ websiteURL, websiteKey })
    const ua =
      'Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:62.0) Gecko/20100101 Firefox/62.0'

    const reg = /there is a robot on the same network \(IP (.*)\) as you/
    const IP = $.html()
      .split('\n')
      .find(line => line.match(reg))
      .match(reg)[1]
    let url = 'https://c.datado.me/captcha/check'

    await this.requestJSON({
      url,
      qs: {
        callbackJsonp: `jQuery18303470315301443705_${Date.now()}`,
        cid,
        icid,
        ccid,
        'g-recaptcha-response': captchaToken,
        hash,
        ua,
        referer: baseUrl,
        parent_url: baseUrl,
        'x-forwarded-for': IP
      }
    })
    throw new Error('captcha solved')
  }

  async tryAuth(login, password) {
    await this.request.get(baseUrl)
    try {
      const json = await this.requestJSON({
        url: 'https://secure.leclercdrive.fr/drive/connecter.ashz',
        qs: {
          callbackJsonp: `jQuery18303470315301443705_${Date.now()}`,
          d: JSON.stringify({
            sLogin: login,
            sMotDePasse: password,
            fResterConnecte: true
          })
        }
      })
      return json
    } catch (err) {
      const captchaUrl = get(err, 'error.url')
      if (captchaUrl) {
        await this.solveDataDomeCaptcha(err)
      } else {
        log('error', err.message)
        throw new Error(errors.VENDOR_DOWN)
      }
    }
  }

  async authenticate(login, password) {
    log('info', 'Authenticating ...')
    let json
    try {
      log('debug', 'first try')
      json = await this.tryAuth(login, password)
    } catch (err) {
      if (err.message === 'captcha solved') {
        log('debug', 'second try')
        json = await this.tryAuth(login, password)
      } else {
        throw err
      }
    }

    const customerDetails = toJson(json).objDonneesReponse

    if (customerDetails.iTypeConnexion === -1) {
      throw new Error(errors.LOGIN_FAILED)
    }
    log('info', 'Successfully logged in')
    return customerDetails.sNoPL
  }

  async fetchMagasinURL(mag) {
    const details = await this.requestJSON(
      `https://api-pointsretrait.leclercdrive.fr/API_PointsRetrait/ApiPointsRetrait/PointsRetraitParNoPointLivraison/na/drive/${mag}`
    )

    // TODO a lot of data to keep about the shop
    return details.sReponse[0].sUrlSiteCourses
  }

  async fetchAndParseCommands(commandURL) {
    const $ = await this.request(commandURL)

    const formData = getFormData($)
    const years = getYears($)

    const commands = await this.getCommands(years, commandURL, formData)

    const formatedCommands = commands.map(({ dates, ...command }) => ({
      ...command,
      date: dates.date,
      vendor: 'Leclerc Drive',
      currency: 'EUR',
      filename: `${dates.isoDateString}-${String(command.amount).replace(
        '.',
        ','
      )}EUR.pdf`
    }))

    return Promise.all(
      formatedCommands.map(async ({ detailsLink, ...command }) => {
        const $ = await this.request(detailsLink)
        const products = scrape(
          $,
          {
            title: {
              sel: `td`,
              fn: $el => {
                const $tr = $el.closest('tr')
                return `${$tr.attr('stitre1')} ${$tr.attr('stitre2')}`.trim()
              }
            },
            id: {
              sel: `td`,
              fn: $el => {
                const $tr = $el.closest('tr')
                return $tr.attr('iidproduit')
              }
            },
            number: {
              sel: `p[class*='_Quantite']`,
              parse: number => Number(number.replace('x', ''))
            },
            price: {
              sel: `p[class*='_Prix']`,
              parse: parseAmount
            }
          },
          `tr[class*='LigneArticle']`
        )

        return {
          ...command,
          products
        }
      })
    )
  }

  getCommands(years, commandURL, formData) {
    return Promise.all(
      years.map(year =>
        this.getCommandsForYear(commandURL, {
          ...formData,
          ...year
        })
      )
    ).then(flatten)
  }

  async getCommandsForYear(commandUrl, formData) {
    const $ = await this.request({
      method: 'POST',
      url: commandUrl,
      form: formData
    })
    return scrape(
      $,
      {
        vendorRef: {
          sel: `a[id*='NumeroCommande']`,
          parse: nb => nb.substr(2)
        },
        detailsLink: {
          sel: `a[id*='NumeroCommande']`,
          attr: 'href'
        },
        fileurl: {
          sel: `a[href*='bon-de-commande.aspx']`,
          attr: 'href'
        },
        dates: {
          sel: `span[id*='_lblCommandeInfo']`,
          parse: date => parseFrenchDate(date)
        },
        amount: {
          sel: `p[class*='MontantCommande']`,
          parse: parseAmount
        }
      },
      `div[id*='_upHistoriqueCommandes'] div[class*='ResumeCommande']`
    )
  }
}

const connector = new LeclercConnector({
  // debug: true,
  cheerio: true,
  json: false
})

connector.run()

function toJson(body) {
  return JSON.parse(body.match(/\(((.*))\)/)[1])
}

function getYears($) {
  const yearSelectElement = $(`select[id*='ddlFiltreAnnees']`)
  const years = Array.from(yearSelectElement.find('option')).map(el => ({
    [yearSelectElement.attr('name')]: $(el).attr('value')
  }))
  if (years.length === 0) {
    if ($.text().includes(`Vous n'avez pas de commande actuellement`)) {
      return []
    } else {
      throw new Error(errors.VENDOR_DOWN)
    }
  }
  return years
}

function getFormData($) {
  const formElement = $('form')
  const dataArray = formElement.serializeArray()
  return dataArray.reduce(
    (acc, input) => ({ ...acc, [input.name]: input.value }),
    {}
  )
}

// Returns both:
// - a date object to be used with e.g. `saveBills()`
// - an ISO date string ready to use in filenames
function parseFrenchDate(frDateString) {
  const isoDateString = frDateString
    .match(/(\d{2})\/(\d{2})\/(\d{4})/)
    .slice(1, 4)
    .reverse()
    .join('-')

  return {
    isoDateString,
    date: new Date(isoDateString)
  }
}

function parseAmount(amountString) {
  return parseFloat(amountString.replace(' €', '').replace(',', '.'))
}

function flatten(arr) {
  return [].concat(...arr)
}

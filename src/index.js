// Force sentry DSN into environment variables
// In the future, will be set by the stack
process.env.SENTRY_DSN =
  process.env.SENTRY_DSN ||
  'https://1f3bcbb057c5435da229ff1039b48baf:1d9127715e7c4f728509d22a2bfe99a5@sentry.cozycloud.cc/47'

const {
  BaseKonnector,
  requestFactory,
  scrape,
  saveBills,
  errors,
  log
} = require('cozy-konnector-libs')
let request = requestFactory({
  // debug: true,
  cheerio: false,
  json: true,
  jar: true
})
const omit = require('lodash/omit')

const baseUrl = 'https://www.leclercdrive.fr'

module.exports = new BaseKonnector(start)

async function start(fields) {
  log('info', 'Authenticating ...')
  let $ = await authenticate(fields.login, fields.password)
  log('info', 'Successfully logged in')

  log('info', 'Fetching the list of commands')
  const commands = await fetchAndParseCommands($)
  log('info', 'Fetching details about each command')
  await fetchDetails(commands)

  log('info', 'Saving data to Cozy')
  await saveBills(commands, fields.folderPath, {
    identifiers: ['leclerc']
  })
}

async function authenticate(login, password) {
  await request(baseUrl)
  let body = await request({
    url: 'https://secure.leclercdrive.fr/drive/connecter.ashz',
    qs: {
      callbackJsonp: 'jQuery18303470315301443705_1525874565308',
      d: JSON.stringify({
        sLogin: login,
        sMotDePasse: password,
        fResterConnecte: false
      })
    }
  })
  body = JSON.parse(body.match(/\(((.*))\)/)[1]).objDonneesReponse

  if (body.iTypeConnexion === -1) {
    throw new Error(errors.LOGIN_FAILED)
  }

  const details = await request({
    method: 'POST',
    url: `${baseUrl}/recupererpointcarte.ashz`,
    form: {
      d: JSON.stringify({
        sIdPointCarte: null,
        sNoPointLivraison: String(body.sNoPL),
        sNoPointRetrait: String(body.sNoPR),
        sIdGroupe: null,
        sUnivers: 'iDRIVE',
        sVue: null
      })
    }
  })

  // TODO a lot of data to keep about the magasin

  request = requestFactory({
    cheerio: true,
    json: false
  })
  return request(details.objDonneesReponse[0].sUrlSite)
}

async function fetchDetails(commands) {
  for (const command of commands) {
    log('debug', 'Details for command')
    log('debug', command)
    const $ = await request(command.detailsLink)
    delete command.detailsLink
    command.products = scrape(
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
  }
}

async function fetchAndParseCommands($) {
  // get the link to commands
  const commandUrl = $(`a[href*='mes-commandes']`)
    .eq(0)
    .attr('href')

  $ = await request(commandUrl)

  const $yearSelector = $(`select[id*='ddlFiltreAnnees']`)
  const years = Array.from($yearSelector.find('option')).map(el =>
    $(el).attr('value')
  )

  const $form = $('form')
  const dataArray = $form.serializeArray()
  const formData = {}
  for (let input of dataArray) {
    formData[input.name] = input.value
  }

  let result = []
  for (const year of years) {
    formData[$yearSelector.attr('name')] = year
    $ = await request({
      method: 'POST',
      url: commandUrl,
      form: formData
    })

    const commands = scrape(
      $,
      {
        commandNumber: {
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

    result = result.concat(commands)
  }

  return result.map(command => {
    return {
      ...omit(command, ['dates']),
      date: command.dates.date,
      vendor: 'Leclerc Drive',
      currency: '€',
      filename: `${command.dates.isoDateString}-${String(
        command.amount
      ).replace('.', ',')}€.pdf`
    }
  })
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

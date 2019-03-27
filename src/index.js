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
const userAgent = 'Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:62.0) Gecko/20100101 Firefox/62.0 Cozycloud'
const request = requestFactory({
  // debug: true,
  cheerio: true,
  json: false,
  jar: true,
  headers: {
    'User-Agent': userAgent // Not working now due to bug, set in each request too
  }
})

const baseUrl = 'https://www.leclercdrive.fr'

module.exports = new BaseKonnector(start)

async function start(fields) {
  log('info', 'Authenticating ...')
  const customerDetails = await authenticate(fields.login, fields.password)
  log('info', 'Successfully logged in')

  const magasinURL = await fetchMagasinURL(customerDetails)
  const $ = await request(magasinURL)
  // get the link to commands
  const commandURL = $(`a[href*='mes-commandes']`)
    .eq(0)
    .attr('href')
  log('info', 'Fetching the list of commands')
  const commands = await fetchAndParseCommands(commandURL)
  log('info', 'Fetching details about each command')

  log('info', 'Saving data to Cozy')
  await saveBills(commands, fields.folderPath, {
    identifiers: ['leclerc'],
    contentType: 'application/pdf',
    requestInstance: request
  })
}

async function authenticate(login, password) {
  const requestJSON = requestFactory({
    cheerio: false,
    json: true,
    jar: true,
    debug: true,
    headers: {
      'User-Agent': userAgent
    }
  })
  await requestJSON(baseUrl)
  const customerDetails = await requestJSON({
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
    .then(toJson)
    .then(response => response.objDonneesReponse)

  if (customerDetails.iTypeConnexion === -1) {
    throw new Error(errors.LOGIN_FAILED)
  }
  return customerDetails
}

async function fetchMagasinURL(customerDetails) {
  const requestJSON = requestFactory({
    cheerio: false,
    json: true,
    jar: true,
    headers: {
      'User-Agent': userAgent
    }
  })
  const details = await requestJSON(
    `https://api-pointsretrait.leclercdrive.fr/API_PointsRetrait/ApiPointsRetrait/PointsRetraitParNoPointLivraison/na/drive/${
      customerDetails.sNoPL
    }`
  )

  // TODO a lot of data to keep about the shop
  return details.sReponse[0].sUrlSiteCourses
}

function toJson(body) {
  return JSON.parse(body.match(/\(((.*))\)/)[1])
}

async function fetchAndParseCommands(commandURL) {
  const $ = await request(commandURL)

  const formData = getFormData($)
  const years = getYears($)

  const commands = await getCommands(years, commandURL, formData)

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
      const $ = await request(detailsLink)
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

function getCommands(years, commandURL, formData) {
  return Promise.all(
    years.map(year =>
      getCommandsForYear(commandURL, {
        ...formData,
        ...year
      })
    )
  ).then(flatten)
}

function getYears($) {
  const yearSelectElement = $(`select[id*='ddlFiltreAnnees']`)
  const years = Array.from(yearSelectElement.find('option')).map(el => ({
    [yearSelectElement.attr('name')]: $(el).attr('value')
  }))
  if (years.length === 0) {
    throw new Error(errors.VENDOR_DOWN)
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

async function getCommandsForYear(commandUrl, formData) {
  const $ = await request({
    method: 'POST',
    url: commandUrl,
    form: formData
  })
  return scrape(
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

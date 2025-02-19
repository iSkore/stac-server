const { pickBy, assign, get: getNested } = require('lodash')
const extent = require('@mapbox/extent')
const { DateTime } = require('luxon')
const AWS = require('aws-sdk')
const { isIndexNotFoundError } = require('./database')
const logger = console

// max number of collections to retrieve
const COLLECTION_LIMIT = process.env.STAC_SERVER_COLLECTION_LIMIT || 100

class ValidationError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ValidationError'
  }
}

const extractIntersects = function (params) {
  let intersectsGeometry
  const { intersects } = params
  if (intersects) {
    let geojson
    // if we receive a string, try to parse as GeoJSON, otherwise assume it is GeoJSON
    if (typeof intersects === 'string') {
      try {
        geojson = JSON.parse(intersects)
      } catch (e) {
        throw new ValidationError('Invalid GeoJSON geometry')
      }
    } else {
      geojson = { ...intersects }
    }

    if (geojson.type === 'FeatureCollection' || geojson.type === 'Feature') {
      throw new Error(
        'Expected GeoJSON geometry, not Feature or FeatureCollection'
      )
    }
    intersectsGeometry = geojson
  }
  return intersectsGeometry
}

const extractBbox = function (params, httpMethod = 'GET') {
  const { bbox } = params
  if (bbox) {
    let bboxArray
    if (httpMethod === 'GET' && typeof bbox === 'string') {
      try {
        bboxArray = bbox.split(',').map(parseFloat).filter((x) => !Number.isNaN(x))
      } catch (e2) {
        throw new ValidationError('Invalid bbox')
      }
    } else if (httpMethod === 'POST' && Array.isArray(bbox)) {
      bboxArray = bbox
    } else {
      throw new ValidationError('Invalid bbox')
    }

    if (bboxArray.length !== 4 && bboxArray.length !== 6) {
      throw new ValidationError('Invalid bbox, must have 4 or 6 points')
    }

    if ((bboxArray.length === 4 && bboxArray[1] > bboxArray[3])
        || (bboxArray.length === 6 && bboxArray[1] > bboxArray[4])) {
      throw new ValidationError('Invalid bbox, SW latitude must be less than NE latitude')
    }

    return extent(bboxArray).polygon()
  }
  return undefined
}

const extractLimit = function (params) {
  const { limit: limitStr } = params

  if (limitStr !== undefined) {
    let limit
    try {
      limit = parseInt(limitStr)
    } catch (e) {
      throw new ValidationError('Invalid limit value')
    }

    if (Number.isNaN(limit) || limit <= 0) {
      throw new ValidationError(
        'Invalid limit value, must be a number between 1 and 10000 inclusive'
      )
    }
    if (limit > 10000) {
      limit = 10000
    }
    return limit
  }
  return undefined
}

const extractPage = function (params) {
  const { page: pageStr } = params

  if (pageStr !== undefined) {
    let page
    try {
      page = parseInt(pageStr)
    } catch (e) {
      throw new ValidationError('Invalid page value')
    }

    if (Number.isNaN(page) || page <= 0) {
      throw new ValidationError(
        'Invalid page value, must be a number greater than 1'
      )
    }
    return page
  }
  return undefined
}

// eslint-disable-next-line max-len
const RFC3339_REGEX = /^(\d\d\d\d)\-(\d\d)\-(\d\d)T(\d\d):(\d\d):(\d\d)([.]\d+)?(Z|([-+])(\d\d):(\d\d))$/

const rfc3339ToDateTime = function (s) {
  if (!RFC3339_REGEX.test(s)) {
    throw new ValidationError('datetime value is invalid, does not match RFC3339 format')
  }
  const dt = DateTime.fromISO(s)
  if (dt.isValid) {
    return dt
  }
  throw new ValidationError(
    `datetime value is invalid, ${dt.invalidReason} ${dt.invalidExplanation}'`
  )
}

const validateStartAndEndDatetimes = function (startDateTime, endDateTime) {
  if (startDateTime && endDateTime && endDateTime < startDateTime) {
    throw new ValidationError(
      'datetime value is invalid, start datetime must be before end datetime with interval'
    )
  }
}

const extractDatetime = function (params) {
  const { datetime } = params

  if (datetime) {
    const datetimeUpperCase = datetime.toUpperCase()
    const [start, end, ...rest] = datetimeUpperCase.split('/')
    if (rest.length) {
      throw new ValidationError(
        'datetime value is invalid, too many forward slashes for an interval'
      )
    } else if ((!start && !end)
        || (start === '..' && end === '..')
        || (!start && end === '..')
        || (start === '..' && !end)
    ) {
      throw new ValidationError(
        'datetime value is invalid, at least one end of the interval must be closed'
      )
    } else {
      const startDateTime = (start && start !== '..') ? rfc3339ToDateTime(start) : undefined
      const endDateTime = (end && end !== '..') ? rfc3339ToDateTime(end) : undefined
      validateStartAndEndDatetimes(startDateTime, endDateTime)
    }
    return datetimeUpperCase
  }
  return undefined
}

const extractStacQuery = function (params) {
  let stacQuery
  const { query } = params
  if (query) {
    if (typeof query === 'string') {
      const parsed = JSON.parse(query)
      stacQuery = parsed
    } else {
      stacQuery = { ...query }
    }
  }
  return stacQuery
}

const extractSortby = function (params) {
  let sortbyRules
  const { sortby } = params
  if (sortby) {
    if (typeof sortby === 'string') {
      // GET request - different syntax
      const sortbys = sortby.split(',')

      sortbyRules = sortbys.map((sortbyRule) => {
        if (sortbyRule[0] === '-') {
          return { field: sortbyRule.slice(1), direction: 'desc' }
        }
        if (sortbyRule[0] === '+') {
          return { field: sortbyRule.slice(1), direction: 'asc' }
        }
        return { field: sortbyRule, direction: 'asc' }
      })
    } else {
      // POST request
      sortbyRules = sortby.slice()
    }
  }
  return sortbyRules
}

const extractFields = function (params) {
  let fieldRules
  const { fields } = params
  if (fields) {
    if (typeof fields === 'string') {
      // GET request - different syntax
      const _fields = fields.split(',')
      const include = []
      _fields.forEach((fieldRule) => {
        if (fieldRule[0] !== '-') {
          include.push(fieldRule)
        }
      })
      const exclude = []
      _fields.forEach((fieldRule) => {
        if (fieldRule[0] === '-') {
          exclude.push(fieldRule.slice(1))
        }
      })
      fieldRules = { include, exclude }
    } else {
      // POST request - JSON
      fieldRules = fields
    }
  } else if (params.hasOwnProperty('fields')) {
    // fields was provided as an empty object
    fieldRules = {}
  }
  return fieldRules
}

const extractIds = function (params) {
  let idsRules
  const { ids } = params
  if (ids) {
    if (typeof ids === 'string') {
      try {
        idsRules = JSON.parse(ids)
      } catch (e) {
        idsRules = ids.split(',')
      }
    } else {
      idsRules = ids.slice()
    }
  }
  return idsRules
}

const extractCollectionIds = function (params) {
  let idsRules
  const { collections } = params
  if (collections) {
    if (typeof collections === 'string') {
      try {
        idsRules = JSON.parse(collections)
      } catch (e) {
        idsRules = collections.split(',')
      }
    } else {
      idsRules = collections.slice()
    }
  }
  return idsRules
}

const parsePath = function (inpath) {
  const searchFilters = {
    root: false,
    api: false,
    conformance: false,
    collections: false,
    search: false,
    collectionId: false,
    items: false,
    itemId: false,
    edit: false
  }
  const api = 'api'
  const conformance = 'conformance'
  const collections = 'collections'
  const search = 'search'
  const items = 'items'
  const edit = 'edit'

  const pathComponents = inpath.split('/').filter((x) => x)
  const { length } = pathComponents
  searchFilters.root = length === 0
  searchFilters.api = pathComponents[0] === api
  searchFilters.conformance = pathComponents[0] === conformance
  searchFilters.collections = pathComponents[0] === collections

  searchFilters.collectionId = pathComponents[0] === collections && length >= 2
    ? pathComponents[1] : false
  searchFilters.search = pathComponents[0] === search
  searchFilters.items = pathComponents[2] === items
  searchFilters.itemId = pathComponents[2] === items && length >= 4 ? pathComponents[3] : false
  searchFilters.edit = pathComponents[4] === edit
  return searchFilters
}

// Impure - mutates results
const addCollectionLinks = function (results, endpoint) {
  results.forEach((result) => {
    const { id } = result
    let { links } = result
    if (links == null) {
      links = []
      result.links = links
    }

    // self link
    links.splice(0, 0, {
      rel: 'self',
      type: 'application/geo+json',
      href: `${endpoint}/collections/${id}`
    })
    // parent catalog
    links.push({
      rel: 'parent',
      type: 'application/geo+json',
      href: `${endpoint}`
    })
    // root catalog
    links.push({
      rel: 'root',
      type: 'application/geo+json',
      href: `${endpoint}`
    })
    // child items
    links.push({
      rel: 'items',
      type: 'application/geo+json',
      href: `${endpoint}/collections/${id}/items`
    })
  })
  return results
}

// Impure - mutates results
const addItemLinks = function (results, endpoint) {
  results.forEach((result) => {
    let { links } = result
    const { id, collection } = result

    links = (links === undefined) ? [] : links
    // self link
    links.splice(0, 0, {
      rel: 'self',
      type: 'application/geo+json',
      href: `${endpoint}/collections/${collection}/items/${id}`
    })
    // parent catalogs
    links.push({
      rel: 'parent',
      type: 'application/json',
      href: `${endpoint}/collections/${collection}`
    })
    links.push({
      rel: 'collection',
      type: 'application/json',
      href: `${endpoint}/collections/${collection}`
    })
    // root catalog
    links.push({
      rel: 'root',
      type: 'application/geo+json',
      href: `${endpoint}`
    })
    links.push({
      rel: 'thumbnail',
      href: `${endpoint}/collections/${collection}/items/${id}/thumbnail`
    })
    result.type = 'Feature'
    return result
  })
  return results
}

const collectionsToCatalogLinks = function (results, endpoint) {
  const stacVersion = process.env.STAC_VERSION || '1.0.0'
  const catalogId = process.env.STAC_ID || 'stac-server'
  const catalogTitle = process.env.STAC_TITLE || 'A STAC API'
  const catalogDescription = process.env.STAC_DESCRIPTION || 'A STAC API running on stac-server'
  const catalog = {
    stac_version: stacVersion,
    type: 'Catalog',
    id: catalogId,
    title: catalogTitle,
    description: catalogDescription
  }

  catalog.links = results.map((result) => {
    const { id } = result
    return {
      rel: 'child',
      type: 'application/geo+json',
      href: `${endpoint}/collections/${id}`
    }
  })
  return catalog
}

const wrapResponseInFeatureCollection = function (
  context, features = [], links = []
) {
  return {
    type: 'FeatureCollection',
    stac_version: process.env.STAC_VERSION || '1.0.0',
    stac_extensions: [],
    context,
    numberMatched: context.matched,
    numberReturned: context.returned,
    features,
    links
  }
}

const buildPaginationLinks = function (limit, parameters, bbox, intersects, endpoint,
  httpMethod, sortby, items) {
  if (items.length) {
    const dictToURI = (dict) => (
      Object.keys(dict).map(
        (p) => {
          let value = dict[p]
          if (typeof value === 'object' && value !== null) {
            if (p === 'sortby') {
              const sortFields = []
              for (let i = 0; i < value.length; i += 1) {
                if (value[i]['direction'] === 'asc') {
                  sortFields.push(value[i]['field'])
                } else {
                  sortFields.push('-'.concat(value[i]['field']))
                }
              }
              value = sortFields.join(',')
            } else if (p === 'collections') {
              value = value.toString()
            } else {
              value = JSON.stringify(value)
            }
          }
          const query = encodeURIComponent(value)
          return `${encodeURIComponent(p)}=${query}`
        }
      ).join('&')
    )

    const lastItem = items[items.length - 1]

    const nextKeys = sortby ? Object.keys(sortby) : ['properties.datetime', 'id', 'collection']

    const next = nextKeys.map((k) => getNested(lastItem, k)).join(',')

    const nextParams = pickBy(assign(parameters, { bbox, intersects, limit, next }))

    const link = {
      rel: 'next',
      title: 'Next page of Items',
      method: httpMethod
    }
    if (httpMethod === 'GET') {
      const nextQueryParameters = dictToURI(nextParams)
      link.href = `${endpoint}?${nextQueryParameters}`
    } else if (httpMethod === 'POST') {
      link.href = endpoint
      link.merge = false
      link.body = nextParams
    }
    return [link]
  }
  return []
}

const searchItems = async function (collectionId, queryParameters, backend, endpoint, httpMethod) {
  logger.debug(`Query parameters: ${JSON.stringify(queryParameters)}`)
  const {
    next,
    bbox,
    intersects
  } = queryParameters
  if (bbox && intersects) {
    throw new ValidationError('Expected bbox OR intersects, not both')
  }
  const datetime = extractDatetime(queryParameters)
  const bboxGeometry = extractBbox(queryParameters, httpMethod)
  const intersectsGeometry = extractIntersects(queryParameters)
  const geometry = intersectsGeometry || bboxGeometry

  const sortby = extractSortby(queryParameters)
  const query = extractStacQuery(queryParameters)
  const fields = extractFields(queryParameters)
  const ids = extractIds(queryParameters)
  const collections = extractCollectionIds(queryParameters)
  const limit = extractLimit(queryParameters)
  const page = extractPage(queryParameters)

  const searchParams = pickBy({
    datetime,
    intersects: geometry,
    query,
    sortby,
    fields,
    ids,
    collections,
    next
  })

  let newEndpoint = `${endpoint}/search`
  if (collectionId) {
    searchParams.collections = [collectionId]
    newEndpoint = `${endpoint}/collections/${collectionId}/items`
  }

  logger.debug(`Search parameters: ${JSON.stringify(searchParams)}`)

  let esResponse
  try {
    esResponse = await backend.search(searchParams, page, limit)
  } catch (error) {
    if (isIndexNotFoundError(error)) {
      esResponse = {
        context: {
          matched: 0,
          returned: 0,
          limit
        },
        results: []
      }
    } else {
      throw error
    }
  }

  const { results: responseItems, context } = esResponse
  const paginationLinks = buildPaginationLinks(
    limit, searchParams, bbox, intersects, newEndpoint, httpMethod, sortby, responseItems
  )

  let links

  if (collectionId) { // add these links for a features request
    links = paginationLinks.concat([
      {
        rel: 'self',
        type: 'application/json',
        href: `${newEndpoint}`
      },
      {
        rel: 'root',
        type: 'application/geo+json',
        href: `${endpoint}`
      }
    ])
  } else {
    links = paginationLinks
  }

  const items = addItemLinks(responseItems, endpoint)
  const response = wrapResponseInFeatureCollection(context, items, links)
  return response
}

// todo: make this more defensive if the named agg doesn't exist
const agg = function (esAggs, name, dataType) {
  const buckets = []
  for (const bucket of esAggs[name].buckets) {
    buckets.push({
      key: bucket.key_as_string || bucket.key,
      data_type: dataType,
      frequency: bucket.doc_count,
      to: bucket.to,
      from: bucket.from,
    })
  }
  return {
    name: name,
    data_type: 'frequency_distribution',
    overflow: esAggs[name].sum_other_doc_count || 0,
    buckets: buckets
  }
}

const aggregate = async function (queryParameters, backend, endpoint, httpMethod) {
  logger.debug(`Aggregate parameters: ${JSON.stringify(queryParameters)}`)
  const {
    bbox,
    intersects
  } = queryParameters
  if (bbox && intersects) {
    throw new ValidationError('Expected bbox OR intersects, not both')
  }
  const datetime = extractDatetime(queryParameters)
  const bboxGeometry = extractBbox(queryParameters, httpMethod)
  const intersectsGeometry = extractIntersects(queryParameters)
  const geometry = intersectsGeometry || bboxGeometry
  const query = extractStacQuery(queryParameters)
  const ids = extractIds(queryParameters)
  const collections = extractCollectionIds(queryParameters)

  const searchParams = pickBy({
    datetime,
    intersects: geometry,
    query,
    ids,
    collections,
  })

  logger.debug(`Aggregate parameters: ${JSON.stringify(searchParams)}`)

  let esResponse
  try {
    esResponse = await backend.aggregate(searchParams)
  } catch (error) {
    if (isIndexNotFoundError(error)) {
      esResponse = {
      }
    } else {
      throw error
    }
  }

  const { body } = esResponse
  const { aggregations: esAggs } = body
  const aggregations = [
    {
      name: 'total_count',
      data_type: 'integer',
      value: esAggs['total_count']['value'],
    },
    {
      name: 'datetime_max',
      data_type: 'datetime',
      value: esAggs['datetime_max']['value_as_string'],
    },
    {
      name: 'datetime_min',
      data_type: 'datetime',
      value: esAggs['datetime_min']['value_as_string'],
    },

    agg(esAggs, 'collection_frequency', 'string'),
    agg(esAggs, 'datetime_frequency', 'datetime'),
    agg(esAggs, 'cloud_cover_frequency', 'numeric'),
    agg(esAggs, 'grid_code_frequency', 'string'),
    agg(esAggs, 'platform_frequency', 'string'),
    agg(esAggs, 'grid_code_landsat_frequency', 'string'),
    agg(esAggs, 'sun_elevation_frequency', 'string'),
    agg(esAggs, 'sun_azimuth_frequency', 'string'),
    agg(esAggs, 'off_nadir_frequency', 'string'),
  ]
  return {
    aggregations,
    links: [{
      rel: 'self',
      type: 'application/json',
      href: `${endpoint}/aggregate`
    },
    {
      rel: 'root',
      type: 'application/geo+json',
      href: `${endpoint}`
    }]
  }
}

const getConformance = async function (txnEnabled) {
  const prefix = 'https://api.stacspec.org/v1.0.0-rc.2'
  const conformsTo = [
    `${prefix}/core`,
    `${prefix}/collections`,
    `${prefix}/ogcapi-features`,
    `${prefix}/ogcapi-features#fields`,
    `${prefix}/ogcapi-features#sort`,
    `${prefix}/ogcapi-features#query`,
    `${prefix}/item-search`,
    `${prefix}/item-search#fields`,
    `${prefix}/item-search#sort`,
    `${prefix}/item-search#query`,
    'https://api.stacspec.org/v0.2.0/aggregation',
    'http://www.opengis.net/spec/ogcapi-features-1/1.0/conf/core',
    'http://www.opengis.net/spec/ogcapi-features-1/1.0/conf/oas30',
    'http://www.opengis.net/spec/ogcapi-features-1/1.0/conf/geojson'
  ]

  if (txnEnabled) {
    conformsTo.push(`${prefix}/ogcapi-features/extensions/transaction`)
  }

  return { conformsTo }
}

const getCatalog = async function (txnEnabled, backend, endpoint = '') {
  const links = [
    {
      rel: 'self',
      type: 'application/geo+json',
      href: `${endpoint}`
    },
    {
      rel: 'root',
      type: 'application/geo+json',
      href: `${endpoint}`
    },
    {
      rel: 'conformance',
      type: 'application/json',
      href: `${endpoint}/conformance`
    },
    {
      rel: 'data',
      type: 'application/json',
      href: `${endpoint}/collections`
    },
    {
      rel: 'search',
      type: 'application/geo+json',
      href: `${endpoint}/search`,
      method: 'GET',
    },
    {
      rel: 'search',
      type: 'application/geo+json',
      href: `${endpoint}/search`,
      method: 'POST',
    },
    {
      rel: 'aggregate',
      type: 'application/json',
      href: `${endpoint}/aggregate`
    },
    {
      rel: 'service-desc',
      type: 'application/vnd.oai.openapi',
      href: `${endpoint}/api`
    },
    {
      rel: 'service-doc',
      type: 'text/html',
      href: `${endpoint}/api.html`
    }
  ]

  const docsUrl = process.env.STAC_DOCS_URL
  if (docsUrl) {
    links.push({
      rel: 'server',
      type: 'text/html',
      href: docsUrl,
    })
  }

  const collections = await backend.getCollections(1, COLLECTION_LIMIT)
  const catalog = collectionsToCatalogLinks(collections, endpoint)
  catalog.links = links.concat(catalog.links)
  catalog.conformsTo = (await getConformance(txnEnabled)).conformsTo

  return catalog
}

const getCollections = async function (backend, endpoint = '') {
  // TODO: implement proper pagination, as this will only return up to
  // COLLECTION_LIMIT collections
  const results = await backend.getCollections(1, COLLECTION_LIMIT)
  const linkedCollections = addCollectionLinks(results, endpoint)
  const resp = {
    collections: results,
    links: [
      {
        rel: 'self',
        type: 'application/json',
        href: `${endpoint}/collections`,
      },
      {
        rel: 'root',
        type: 'application/geo+json',
        href: `${endpoint}`,
      },
    ],
    context: {
      page: 1,
      limit: COLLECTION_LIMIT,
      matched: linkedCollections && linkedCollections.length,
      returned: linkedCollections && linkedCollections.length
    }
  }
  return resp
}

const getCollection = async function (collectionId, backend, endpoint = '') {
  const result = await backend.getCollection(collectionId)
  if (result instanceof Error) {
    return new Error('Collection not found')
  }
  const col = addCollectionLinks([result], endpoint)
  if (col.length > 0) {
    return col[0]
  }
  return new Error('Collection retrieval failed')
}

const createCollection = async function (collection, backend) {
  const response = await backend.indexCollection(collection)
  logger.debug(`Create Collection: ${JSON.stringify(response)}`)

  if (response) {
    return response
  }
  return new Error(`Error creating collection ${collection}`)
}

const getItem = async function (collectionId, itemId, backend, endpoint = '') {
  const itemQuery = { collections: [collectionId], id: itemId }
  const { results } = await backend.search(itemQuery)
  const [it] = addItemLinks(results, endpoint)
  if (it) {
    return it
  }
  return new Error('Item not found')
}

const partialUpdateItem = async function (
  collectionId, itemId, queryParameters, backend, endpoint = ''
) {
  const response = await backend.partialUpdateItem(collectionId, itemId, queryParameters)
  logger.debug(`Partial Update Item: ${JSON.stringify(response)}`)
  if (response) {
    return addItemLinks([response.body.get._source], endpoint)[0]
  }
  return new Error(`Error partially updating item ${itemId}`)
}

const createItem = async function (item, backend) {
  const response = await backend.indexItem(item)
  logger.debug(`Create Item: ${JSON.stringify(response)}`)

  if (response) {
    return response
  }
  return new Error(`Error creating item in collection ${item.collection}`)
}

const updateItem = async function (item, backend) {
  const response = await backend.updateItem(item)
  logger.debug(`Update Item: ${JSON.stringify(response)}`)

  if (response) {
    return response
  }
  return new Error(`Error updating item ${item.id}`)
}

const deleteItem = async function (collectionId, itemId, backend) {
  const response = await backend.deleteItem(collectionId, itemId)
  logger.debug(`Delete Item: ${response}`)
  if (response) {
    return response
  }
  return new Error(`Error deleting item ${collectionId}/${itemId}`)
}

const getItemThumbnail = async function (collectionId, itemId, backend) {
  const itemQuery = { collections: [collectionId], id: itemId }
  const { results } = await backend.search(itemQuery)
  const [item] = results
  if (!item) {
    return new Error('Item not found')
  }

  const thumbnailAsset = Object.values(item.assets || []).find(
    (x) => x.roles && x.roles.includes('thumbnail')
  )

  if (!thumbnailAsset) {
    return new Error('Thumbnail not found')
  }

  let location
  if (thumbnailAsset.href && thumbnailAsset.href.startsWith('http')) {
    location = thumbnailAsset.href
  } else if (thumbnailAsset.href && thumbnailAsset.href.startsWith('s3')) {
    const withoutProtocol = thumbnailAsset.href.substring(5) // chop off s3://
    const [bucket, ...keyArray] = withoutProtocol.split('/')
    const key = keyArray.join('/')
    location = new AWS.S3().getSignedUrl('getObject', {
      Bucket: bucket,
      Key: key,
      Expires: 60 * 5, // expiry in seconds
      RequestPayer: 'requester'
    })
  } else {
    return new Error('Thumbnail not found')
  }

  return { location }
}

const healthCheck = async function (backend) {
  const response = await backend.healthCheck()
  logger.debug(`Health check: ${response}`)
  if (response && response.statusCode === 200) {
    return { status: 'ok' }
  }
  return new Error('Error with health check.')
}

module.exports = {
  getConformance,
  getCatalog,
  getCollections,
  getCollection,
  createCollection,
  getItem,
  searchItems,
  parsePath,
  extractIntersects,
  extractBbox,
  createItem,
  deleteItem,
  updateItem,
  partialUpdateItem,
  ValidationError,
  extractLimit,
  extractDatetime,
  aggregate,
  getItemThumbnail,
  healthCheck,
}

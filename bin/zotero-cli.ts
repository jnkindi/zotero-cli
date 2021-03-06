#!/usr/bin/env node

require('dotenv').config()
require('docstring')
const os = require('os')

import { ArgumentParser } from 'argparse'
import { parse as TOML } from '@iarna/toml'
import fs = require('fs')
import path = require('path')

import request = require('request-promise')
import * as LinkHeader from 'http-link-header'

import Ajv = require('ajv')
const ajv = new Ajv()

const md5 = require('md5-file')

function sleep(msecs) {
  return new Promise(resolve => setTimeout(resolve, msecs))
}

const arg = new class {
  integer(v) {
    if (isNaN(parseInt(v))) throw new Error(`${JSON.stringify(v)} is not an integer`)
    return parseInt(v)
  }

  file(v) {
    if (!fs.existsSync(v) || !fs.lstatSync(v).isFile()) throw new Error(`${JSON.stringify(v)} is not a file`)
    return v
  }

  path(v) {
    if (!fs.existsSync(v)) throw new Error(`${JSON.stringify(v)} does not exist`)
    return v
  }

  json(v) {
    return JSON.parse(v)
  }
}

class Zotero {
  args: any
  output: string = ''
  parser: any
  config: any
  zotero: any
  base = 'https://api.zotero.org'
  headers = {
    'User-Agent': 'Zotero-CLI',
    'Zotero-API-Version': '3',
  }

  async run() {
    this.output = ''
    // global parameters for all commands
    this.parser = new ArgumentParser
    this.parser.addArgument('--api-key', { help: 'The API key to access the Zotero API.' })
    this.parser.addArgument('--config', { type: arg.file, help: 'Configuration file (toml format). Note that ./zotero-cli.toml and ~/.config/zotero-cli/zotero-cli.toml is picked up automatically.' })
    this.parser.addArgument('--user-id', { type: arg.integer, help: 'The id of the user library.' })
    this.parser.addArgument('--group-id', { type: arg.integer, help: 'The id of the group library.' })
    this.parser.addArgument('--indent', { type: arg.integer, help: 'Identation for json output.' })
    this.parser.addArgument('--out', { help: 'Output to file' })
    this.parser.addArgument('--verbose', { action: 'storeTrue', help: 'Log requests.' })

    const subparsers = this.parser.addSubparsers({ title: 'commands', dest: 'command', required: true })
    // add all methods that do not start with _ as a command
    for (const cmd of Object.getOwnPropertyNames(Object.getPrototypeOf(this)).sort()) {
      if (typeof this[cmd] !== 'function' || cmd[0] !== '$') continue

      const sp = subparsers.addParser(cmd.slice(1).replace(/_/g, '-'), { description: this[cmd].__doc__, help: this[cmd].__doc__ })
      // when called with an argparser, the command is expected to add relevant parameters and return
      // the command must have a docstring
      this[cmd](sp)
    }

    this.args = this.parser.parseArgs()

    // pick up config
    const config: string = [this.args.config, 'zotero-cli.toml', `${os.homedir()}/.config/zotero-cli/zotero-cli.toml`].find(cfg => fs.existsSync(cfg))
    this.config = config ? TOML(fs.readFileSync(config, 'utf-8')) : {}

    if (this.args.user_id || this.args.group_id) {
      //Overwriting command line option in config
      delete this.config['user-id']
      delete this.config['group-id']

      this.config['user-id'] = this.args.user_id
      this.config['group-id'] = this.args.group_id

      if (!this.config['user-id']) delete this.config['user-id']
      if (!this.config['group-id']) delete this.config['group-id']
    }

    // expand selected command
    const options = [].concat.apply([], this.parser._actions.map(action => action.dest === 'command' ? action.choices[this.args.command] : [action]))
    for (const option of options) {
      if (!option.dest) continue
      if (['help', 'config'].includes(option.dest)) continue

      if (this.args[option.dest] !== null) continue

      let value

      // first try explicit config
      if (typeof value === 'undefined' && this.args.config) {
        value = (this.config[this.args.command] || {})[option.dest.replace(/_/g, '-')]
        if (typeof value === 'undefined') value = this.config[option.dest.replace(/_/g, '-')]
      }

      // next, ENV vars. Also picks up from .env
      if (typeof value === 'undefined') {
        value = process.env[`ZOTERO_CLI_${option.dest.toUpperCase()}`] || process.env[`ZOTERO_${option.dest.toUpperCase()}`]
      }

      // last, implicit config
      if (typeof value === 'undefined') {
        value = (this.config[this.args.command] || {})[option.dest.replace(/_/g, '-')]
        if (typeof value === 'undefined') value = this.config[option.dest.replace(/_/g, '-')]
      }

      if (typeof value === 'undefined') continue

      if (option.type === arg.integer) {
        if (isNaN(parseInt(value))) this.parser.error(`${option.dest} must be numeric, not ${value}`)
        value = parseInt(value)

      } else if (option.type === arg.path) {
        if (!fs.existsSync(value)) this.parser.error(`${option.dest}: ${value} does not exist`)

      } else if (option.type === arg.file) {
        if (!fs.existsSync(value) || !fs.lstatSync(value).isFile()) this.parser.error(`${option.dest}: ${value} is not a file`)

      } else if (option.type === arg.json && typeof value === 'string') {
        try {
          value = JSON.parse(value)
        } catch (err) {
          this.parser.error(`${option.dest}: ${JSON.stringify(value)} is not valid JSON`)
        }

      } else if (option.choices) {
        if (!option.choices.includes(value)) this.parser.error(`${option.dest} must be one of ${option.choices}`)

      } else if (option.action === 'storeTrue' && typeof value === 'string') {
        const _value = {
          true: true,
          yes: true,
          on: true,

          false: false,
          no: false,
          off: false,
        }[value]
        if (typeof _value === 'undefined') this.parser.error(`%{option.dest} must be boolean, not ${value}`)
        value = _value

      } else {
        // string
      }

      this.args[option.dest] = value
    }

    if (!this.args.api_key) this.parser.error('no API key provided')
    this.headers['Zotero-API-Key'] = this.args.api_key

    if (this.args.user_id === null && this.args.group_id === null) this.parser.error('You must provide exactly one of --user-id or --group-id')
    if (this.args.user_id !== null && this.args.group_id !== null) this.parser.error('You must provide exactly one of --user-id or --group-id')
    if (this.args.user_id === 0) this.args.user_id = (await this.get(`/keys/${this.args.api_key}`, { userOrGroupPrefix: false })).userID

    // using default=2 above prevents the overrides from being picked up
    if (this.args.indent === null) this.args.indent = 2

    // call the actual command
    try {
      await this['$' + this.args.command.replace(/-/g, '_')]()
    } catch (ex) {
      this.print('Command execution failed: ', ex)
      process.exit(1)
    }

    if (this.args.out) fs.writeFileSync(this.args.out, this.output)
  }

  public print(...args: any[]) {
    if (!this.args.out) {
      console.log.apply(console, args)

    } else {
      this.output += args.map(m => {
        const type = typeof m

        if (type === 'string' || m instanceof String || type === 'number' || type === 'undefined' || type === 'boolean' || m === null) return m

        if (m instanceof Error) return `<Error: ${m.message || m.name}${m.stack ? `\n${m.stack}` : ''}>`

        if (m && type === 'object' && m.message) return `<Error: ${m.message}#\n${m.stack}>`

        return JSON.stringify(m, null, this.args.indent)

      }).join(' ') + '\n'
    }
  }

  async all(uri, params = {}) {
    let chunk = await this.get(uri, { resolveWithFullResponse: true, params })
    let data = chunk.body

    let link = chunk.headers.link && LinkHeader.parse(chunk.headers.link).rel('next')
    while (link && link.length && link[0].uri) {
      if (chunk.headers.backoff) await sleep(parseInt(chunk.headers.backoff) * 1000)

      chunk = await request({
        uri: link[0].uri,
        headers: this.headers,
        json: true,
        resolveWithFullResponse: true,
      })
      data = data.concat(chunk.body)
      link = chunk.headers.link && LinkHeader.parse(chunk.headers.link).rel('next')
    }
    return data
  }

  async get(uri, options: { userOrGroupPrefix?: boolean, params?: any, resolveWithFullResponse?: boolean, json?: boolean } = {}) {
    if (typeof options.userOrGroupPrefix === 'undefined') options.userOrGroupPrefix = true
    if (typeof options.params === 'undefined') options.params = {}
    if (typeof options.json === 'undefined') options.json = true

    let prefix = ''
    if (options.userOrGroupPrefix) prefix = this.args.user_id ? `/users/${this.args.user_id}` : `/groups/${this.args.group_id}`

    const params = Object.keys(options.params).map(param => {
      let values = options.params[param]
      if (!Array.isArray(values)) values = [values]
      return values.map(v => `${param}=${encodeURI(v)}`).join('&')
    }).join('&')

    uri = `${this.base}${prefix}${uri}${params ? '?' + params : ''}`
    if (this.args.verbose) console.error('GET', uri)

    return request({
      uri,
      headers: this.headers,
      encoding: null,
      json: options.json,
      resolveWithFullResponse: options.resolveWithFullResponse,
    })
  }

  async post(uri, data, headers = {}) {
    const prefix = this.args.user_id ? `/users/${this.args.user_id}` : `/groups/${this.args.group_id}`

    uri = `${this.base}${prefix}${uri}`
    if (this.args.verbose) console.error('POST', uri)

    return request({
      method: 'POST',
      uri,
      headers: { ...this.headers, 'Content-Type': 'application/json', ...headers },
      body: data,
    })
  }

  async put(uri, data) {
    const prefix = this.args.user_id ? `/users/${this.args.user_id}` : `/groups/${this.args.group_id}`

    uri = `${this.base}${prefix}${uri}`
    if (this.args.verbose) console.error('PUT', uri)

    return request({
      method: 'PUT',
      uri,
      headers: { ...this.headers, 'Content-Type': 'application/json' },
      body: data,
    })
  }

  async patch(uri, data, version?: number) {
    const prefix = this.args.user_id ? `/users/${this.args.user_id}` : `/groups/${this.args.group_id}`

    const headers = { ...this.headers, 'Content-Type': 'application/json' }
    if (typeof version !== 'undefined') headers['If-Unmodified-Since-Version'] = version

    uri = `${this.base}${prefix}${uri}`
    if (this.args.verbose) console.error('PATCH', uri)

    return request({
      method: 'PATCH',
      uri,
      headers,
      body: data,
    })
  }

  async delete(uri, version?: number) {
    const prefix = this.args.user_id ? `/users/${this.args.user_id}` : `/groups/${this.args.group_id}`

    const headers = { ...this.headers, 'Content-Type': 'application/json' }
    if (typeof version !== 'undefined') headers['If-Unmodified-Since-Version'] = version

    uri = `${this.base}${prefix}${uri}`
    if (this.args.verbose) console.error('DELETE', uri)

    return request({
      method: 'DELETE',
      uri,
      headers,
    })
  }

  async count(uri, params = {}) {
    return (await this.get(uri, { resolveWithFullResponse: true, params })).headers['total-results']
  }

  show(v) {
    this.print(JSON.stringify(v, null, this.args.indent).replace(new RegExp(this.args.api_key, 'g'), '<API-KEY>'))
  }

  /// THE COMMANDS ///

  async $key(argparser = null) {
    /** Show details about this API key. (API: /keys ) */

    if (argparser) return

    this.show(await this.get(`/keys/${this.args.api_key}`, { userOrGroupPrefix: false }))
  }

  async $collection(argparser = null) {
    /** Retrieve information about a specific collection --key KEY (API: /collection/KEY or /collection/KEY/tags)   */

    if (argparser) {
      argparser.addArgument('--key', { required: true, help: 'The key of the item.' })
      argparser.addArgument('--tags', { action: 'storeTrue', help: 'Display tags present in the collection.' })
      argparser.addArgument('--add', { action: 'storeTrue', help: 'Add items to this collection.' })
      argparser.addArgument('itemkeys', { nargs: '*' })
      argparser.addArgument('--remove', { nargs: '*', help: 'Remove items from this collection.' })
      return
    }

    if (this.args.tags && this.args.add) {
      this.parser.error('--tags cannot be combined with --add')
      return
    }
    if (this.args.add && !this.args.itemkeys.length) {
      this.parser.error('--add requires item keys')
      return
    }
    if (!this.args.add && this.args.itemkeys.length) {
      this.parser.error('unexpected item keys')
      return
    }

    if (this.args.add) {
      for (const itemKey of this.args.itemkeys) {
        const item = await this.get(`/items/${itemKey}`)
        if (item.data.collections.includes(this.args.key)) continue
        await this.patch(`/items/${itemKey}`, JSON.stringify({ collections: item.data.collections.concat(this.args.key) }), item.version)
      }
    }

    if (this.args.remove) {
      for (const itemKey of this.args.remove) {
        const item = await this.get(`/items/${itemKey}`)
        const index = item.data.collections.indexOf(this.args.key)
        if (index > -1) {
          item.data.collections.splice(index, 1)
        }
        await this.patch(`/items/${itemKey}`, JSON.stringify({ collections: item.data.collections }), item.version)
      }
    }

    this.show(await this.get(`/collections/${this.args.key}${this.args.tags ? '/tags' : ''}`))
  }

  async $collections(argparser = null) {
    /** Retrieve a list of collections or create a collection. (API: /collections or /collection/top) */

    if (argparser) {
      argparser.addArgument('--top', { action: 'storeTrue', help: 'Show only collection at top level.' })
      argparser.addArgument('--key', { help: 'Show all the child collections of the key.' })
      argparser.addArgument('--create-child', { nargs: '*', help: 'Create child collections of key (or at the top level if no key is specified) with the names specified.' })
      return
    }

    if (this.args.create_child) {
      const response = await this.post('/collections',
        JSON.stringify(this.args.create_child.map(c => { return { name: c, parentCollection: this.args.key } })))
      this.print('Collections created: ', JSON.parse(response).successful)
      return
    }


    let collections = null;
    if (this.args.key) {
      collections = await this.all(`/collections/${this.args.key}/collections`)
    } else {
      collections = await this.all(`/collections${this.args.top ? '/top' : ''}`)
    }

    this.show(collections)
  }

  async $items(argparser = null) {
    /** Retrieve a list of items items from the library, e.g. collection/top. (API: /items/...) */

    let items

    if (argparser) {
      argparser.addArgument('--count', { action: 'storeTrue', help: 'TODO: document' })
      argparser.addArgument('--all', { action: 'storeTrue', help: 'TODO: document' })
      argparser.addArgument('--filter', { type: arg.json, help: 'TODO: document' })
      argparser.addArgument('--collection', { help: 'Retrive list of items for collection' })
      argparser.addArgument('--top', { action: 'storeTrue', help: 'TODO: document' })
      argparser.addArgument('--validate', { type: arg.path, help: 'json-schema file for all itemtypes, or directory with schema files, one per itemtype' })
      return
    }

    if (this.args.count && this.args.validate) {
      this.parser.error('--count cannot be combined with --validate')
      return
    }

    const collection = this.args.collection ? `/collections/${this.args.collection}` : ''

    if (this.args.count) {
      this.print(await this.count(`${collection}/items${this.args.top ? '/top' : ''}`, this.args.filter || {}))
      return
    }

    const params = this.args.filter || {}

    if (this.args.top) {
      items = await this.get(`${collection}/items/top`, { params })
    } else if (params.limit) {
      items = await this.get(`${collection}/items`, { params })
    } else {
      items = await this.all(`${collection}/items`, params)
    }

    if (this.args.validate) {
      if (!fs.existsSync(this.args.validate)) throw new Error(`${this.args.validate} does not exist`)

      const oneSchema = fs.lstatSync(this.args.validate).isFile()

      let validate = oneSchema ? ajv.compile(JSON.parse(fs.readFileSync(this.args.validate, 'utf-8'))) : null

      const validators = {}
      // still a bit rudimentary
      for (const item of items) {
        if (!oneSchema) {
          validate = validators[item.itemType] = validators[item.itemType] || ajv.compile(JSON.parse(fs.readFileSync(path.join(this.args.validate, `${item.itemType}.json`), 'utf-8')))
        }

        if (!validate(item)) this.show(validate.errors)
      }

    } else {
      this.show(items)
    }
  }

  async $item(argparser = null) {
    /** Retrieve children for item --key KEY. (API: /items/KEY/ or /items/KEY/children) */
    if (argparser) {
      argparser.addArgument('--key', { required: true, help: 'The key of the item.' })
      argparser.addArgument('--children', { action: 'storeTrue', help: 'TODO: document' })
      argparser.addArgument('--filter', { type: arg.json, help: 'TODO: document' })
      argparser.addArgument('--addtocollection', { nargs: '*', help: 'Add item to collections' })
      argparser.addArgument('--removefromcollection', { nargs: '*', help: 'Remove item from collections' })
      argparser.addArgument('--addtags', { nargs: '*', help: 'Add tags to item.' })
      argparser.addArgument('--removetags', { nargs: '*', help: 'Remove tags from item.' })
      argparser.addArgument('--addfile', { nargs: '*', help: 'Upload attachments to the item.' })
      argparser.addArgument('--savefiles', { nargs: '*', help: 'Download all attachments from the item.' })
      return
    }

    const item = await this.get(`/items/${this.args.key}`)

    if (this.args.savefiles) {
      let children = await this.get(`/items/${this.args.key}/children`);
      await Promise.all(children.filter(item => item.data.itemType === 'attachment').map(async item => {
        console.log(`Downloading file ${item.data.filename}`)
        fs.writeFileSync(item.data.filename, await this.get(`/items/${item.key}/file`), 'binary')
      }))
    }

    if (this.args.addfile) {
      const attachmentTemplate = await this.get('/items/new?itemType=attachment&linkMode=imported_file', { userOrGroupPrefix: false })
      for (const filename of this.args.addfile) {
        if (!fs.existsSync(filename)) {
          console.log(`Ignoring non-existing file: ${filename}`);
          return
        }

        let attach = attachmentTemplate;
        attach.title = path.basename(filename)
        attach.filename = path.basename(filename)
        attach.contentType = `application/${path.extname(filename).slice(1)}`
        attach.parentItem = this.args.key
	const stat = fs.statSync(filename)
        const uploadItem = JSON.parse(await this.post('/items', JSON.stringify([attach])))
        const uploadAuth = JSON.parse(await this.post(`/items/${uploadItem.successful[0].key}/file?md5=${md5.sync(filename)}&filename=${attach.filename}&filesize=${fs.statSync(filename)['size']}&mtime=${stat.mtimeMs}`, '{}', { 'If-None-Match': '*' }))
        if (uploadAuth.exists !== 1) {
          const uploadResponse = await request({
            method: 'POST',
            uri: uploadAuth.url,
            body: Buffer.concat([Buffer.from(uploadAuth.prefix), fs.readFileSync(filename), Buffer.from(uploadAuth.suffix)]),
            headers: { 'Content-Type': uploadAuth.contentType }
          })
          await this.post(`/items/${uploadItem.successful[0].key}/file?upload=${uploadAuth.uploadKey}`, '{}', { 'Content-Type': 'application/x-www-form-urlencoded', 'If-None-Match': '*' })
        }
      }
    }

    if (this.args.addtocollection) {
      let newCollections = item.data.collections
      this.args.addtocollection.forEach(itemKey => {
        if (!newCollections.includes(itemKey)) {
          newCollections.push(itemKey)
        }
      })
      await this.patch(`/items/${this.args.key}`, JSON.stringify({ collections: newCollections }), item.version)
    }

    if (this.args.removefromcollection) {
      let newCollections = item.data.collections
      this.args.removefromcollection.forEach(itemKey => {
        const index = newCollections.indexOf(itemKey)
        if (index > -1) {
          newCollections.splice(index, 1)
        }
      })
      await this.patch(`/items/${this.args.key}`, JSON.stringify({ collections: newCollections }), item.version)
    }

    if (this.args.addtags) {
      let newTags = item.data.tags
      this.args.addtags.forEach(tag => {
        if (!newTags.find(newTag => newTag.tag === tag)) {
          newTags.push({ tag })
        }
      })
      await this.patch(`/items/${this.args.key}`, JSON.stringify({ tags: newTags }), item.version)
    }

    if (this.args.removetags) {
      let newTags = item.data.tags.filter(tag => !this.args.removetags.includes(tag.tag))
      await this.patch(`/items/${this.args.key}`, JSON.stringify({ tags: newTags }), item.version)
    }

    const params = this.args.filter || {}
    if (this.args.children) {
      this.show(await this.get(`/items/${this.args.key}/children`, { params }))
    } else {
      this.show(await this.get(`/items/${this.args.key}`, { params }))
    }
  }

  async $publications(argparser = null) {
    /** Return a list of items in publications (user library only). (API: /publications/items) */

    if (argparser) return

    const items = await this.get('/publications/items')
    this.show(items)
  }

  async $trash(argparser = null) {
    /** Return a list of items in the trash. */

    if (argparser) return

    const items = await this.get('/items/trash')
    this.show(items)
  }

  async $tags(argparser = null) {
    /** Return a list of tags in the library. Options to filter and count tags. (API: /tags) */

    if (argparser) {
      argparser.addArgument('--filter', { help: 'Tags of all types matching a specific name.' })
      argparser.addArgument('--count', { action: 'storeTrue', help: 'TODO: document' })
      return
    }

    let rawTags = null;
    if (this.args.filter) {
      rawTags = await this.all(`/tags/${encodeURIComponent(this.args.filter)}`)
    } else {
      rawTags = await this.all('/tags')
    }
    const tags = rawTags.map(tag => tag.tag).sort()

    if (this.args.count) {
      const tag_counts: Record<string, number> = {}
      for (const tag of tags) {
        tag_counts[tag] = await this.count('/items', { tag })
      }
      this.print(tag_counts)

    } else {
      this.show(tags)
    }
  }

  async $searches(argparser = null) {
    /** Return/Create a list of the saved searches of the library. (API: /searches) */

    if (argparser) {
      argparser.addArgument('--create', { nargs: 1, help: 'Path of JSON file containing the definitions of saved searches.' })
      return
    }

    if (this.args.create) {
      let searchDef = [];
      try {
        searchDef = JSON.parse(fs.readFileSync(this.args.create[0], 'utf8'))
      } catch (ex) {
        console.log('Invalid search definition: ', ex)
      }

      if (!Array.isArray(searchDef)) {
        searchDef = [searchDef]
      }

      await this.post('/searches', JSON.stringify(searchDef))
      this.print('Saved search(s) created successfully.')
      return
    }

    const items = await this.get('/searches')
    this.show(items)
  }

  async $attachment(argparser = null) {
    /** Retrieve/save attachments for the item specified with --key KEY. (API: /items/KEY/file) */

    if (argparser) {
      argparser.addArgument('--key', { required: true, help: 'The key of the item.' })
      argparser.addArgument('--save', { required: true, help: 'Filename to save attachment to' })
      return
    }

    fs.writeFileSync(this.args.save, await this.get(`/items/${this.args.key}/file`), 'binary')
  }

  async $types(argparser = null) {
    /** Retrieve a list of items types available in Zotero. (API: /itemTypes) */

    if (argparser) return

    this.show(await this.get('/itemTypes', { userOrGroupPrefix: false }))
  }

  async $groups(argparser = null) {
    /** Retrieve the Zotero groups data to which the current library_id and api_key has access to. (API: /users/<user-id>/groups) */
    if (argparser) return

    this.show(await this.get('/groups'))
  }

  async $fields(argparser = null) {
    /**
     * Retrieve a template with the fields for --type TYPE (API: /itemTypeFields, /itemTypeCreatorTypes) or all item fields (API: /itemFields).
     * Note that to retrieve a template, use 'create-item --template TYPE' rather than this command.
     */

    if (argparser) {
      argparser.addArgument('--type', { help: 'Display fields types for TYPE.' })
      return
    }

    if (this.args.type) {
      this.show(await this.get('/itemTypeFields', { params: { itemType: this.args.type }, userOrGroupPrefix: false }))
      this.show(await this.get('/itemTypeCreatorTypes', { params: { itemType: this.args.type }, userOrGroupPrefix: false }))
    } else {
      this.show(await this.get('/itemFields', { userOrGroupPrefix: false }))
    }
  }

  async $create_item(argparser = null) {
    /** Create a new item or items. (API: /items/new) You can retrieve a template with the --template option.  */

    if (argparser) {
      argparser.addArgument('--template', { help: "Retrieve a template for the item you wish to create. You can retrieve the template types using the main argument 'types'." })
      argparser.addArgument('items', { nargs: '*', help: 'Json files for the items to be created.' })
      return
    }

    if (this.args.template) {
      this.show(await this.get('/items/new', { userOrGroupPrefix: false, params: { itemType: this.args.template } }))
      return
    }

    if (!this.args.items.length) this.parser.error('Need at least one item to create')

    const items = this.args.items.map(item => JSON.parse(fs.readFileSync(item, 'utf-8')))
    this.print(await this.post('/items', JSON.stringify(items)))
  }

  async $update_item(argparser = null) {
    /** Update/replace an item (--key KEY), either update (API: patch /items/KEY) or replacing (using --replace, API: put /items/KEY). */

    if (argparser) {
      argparser.addArgument('--key', { required: true, help: 'The key of the item.' })
      argparser.addArgument('--replace', { action: 'storeTrue', help: 'Replace the item[s] by sumbitting the complete json.' })
      argparser.addArgument('items', { nargs: 1, help: 'Path of one or more item files in json format.' })
      return
    }

    const originalItem = await this.get(`/items/${this.args.key}`)
    for (const item of this.args.items) {
      await this[this.args.replace ? 'put' : 'patch'](`/items/${this.args.key}`, fs.readFileSync(item), originalItem.version)
    }
  }

  async $get(argparser = null) {
    /** Make a direct query to the API. */

    if (argparser) {
      argparser.addArgument('--root', { action: 'storeTrue', help: 'TODO: document' })
      argparser.addArgument('uri', { nargs: '+', help: 'TODO: document' })
      return
    }

    for (const uri of this.args.uri) {
      this.show(await this.get(uri, { userOrGroupPrefix: !this.args.root }))
    }
  }

  async $post(argparser = null) {
    /** Make a direct query to the API. */

    if (argparser) {
      argparser.addArgument('uri', { nargs: '1', help: 'TODO: document' })
      argparser.addArgument('--data', { required: true, help: 'Escaped JSON string for post data' })
      return
    }

    this.print(await this.post(this.args.uri, this.args.data))
  }

  async $put(argparser = null) {
    /** Make a direct query to the API. */

    if (argparser) {
      argparser.addArgument('uri', { nargs: '1', help: 'TODO: document' })
      argparser.addArgument('--data', { required: true, help: 'Escaped JSON string for post data' })
      return
    }

    this.print(await this.put(this.args.uri, this.args.data))
  }

  async $delete(argparser = null) {
    /** Make a direct delete query to the API. */

    if (argparser) {
      argparser.addArgument('uri', { nargs: '+', help: 'Request uri' })
      return
    }

    for (const uri of this.args.uri) {
      const response = await this.get(uri)
      await this.delete(uri, response.version)
    }
  }
}

(new Zotero).run().catch(err => {
  console.error('error:', err)
  process.exit(1)
})

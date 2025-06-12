const fs = require('fs')
const path = require('path')
const express = require('express')
const request = require('./util/request')
const packageJSON = require('./package.json')
const exec = require('child_process').exec
const cache = require('./util/apicache').middleware
const { cookieToJson } = require('./util/index')
const fileUpload = require('express-fileupload')
const decode = require('safe-decode-uri-component')
const axios = require('axios')

const url = require('url')
const https = require('https')
const http = require('http')

async function downloadMP3(link, outputPath) {
  // 解析 URL 确定协议
  const parsedUrl = url.parse(link)
  const isHttps = parsedUrl.protocol === 'https:'
  const transport = isHttps ? https : http

  // 重定向计数器（防止无限重定向）
  let redirectCount = 0
  let currentUrl = link

  while (redirectCount < 5) {
    const result = await new Promise((resolve, reject) => {
      const request = transport.get(currentUrl, (response) => {
        // 处理重定向 (3xx 状态码)
        if ([301, 302, 307, 308].includes(response.statusCode)) {
          redirectCount++
          if (response.headers.location) {
            currentUrl = response.headers.location
            return resolve({ redirect: true })
          }
          return reject(new Error('重定向位置未指定'))
        }

        // 检查响应状态
        if (response.statusCode !== 200) {
          return reject(new Error(`请求失败，状态码: ${response.statusCode}`))
        }

        // 收集二进制数据
        const chunks = []
        response.on('data', (chunk) => chunks.push(chunk))
        response.on('end', () =>
          resolve({
            data: Buffer.concat(chunks),
            contentType: response.headers['content-type'],
          }),
        )
      })

      request.on('error', reject)
    })

    // 如果是重定向则继续
    if (result.redirect) continue

    // 验证内容类型
    if (!result.contentType || !result.contentType.includes('audio/mpeg')) {
      console.warn('⚠️ 内容类型不是 audio/mpeg:', result.contentType)
    }

    // 保存文件
    // await fs.promises.writeFile(outputPath, result.data);
    return result.data
  }

  throw new Error('重定向次数超过限制')
}

/**
 * The version check result.
 * @readonly
 * @enum {number}
 */
const VERSION_CHECK_RESULT = {
  FAILED: -1,
  NOT_LATEST: 0,
  LATEST: 1,
}

/**
 * @typedef {{
 *   identifier?: string,
 *   route: string,
 *   module: any
 * }} ModuleDefinition
 */

/**
 * @typedef {{
 *   port?: number,
 *   host?: string,
 *   checkVersion?: boolean,
 *   moduleDefs?: ModuleDefinition[]
 * }} NcmApiOptions
 */

/**
 * @typedef {{
 *   status: VERSION_CHECK_RESULT,
 *   ourVersion?: string,
 *   npmVersion?: string,
 * }} VersionCheckResult
 */

/**
 * @typedef {{
 *  server?: import('http').Server,
 * }} ExpressExtension
 */

/**
 * Get the module definitions dynamically.
 *
 * @param {string} modulesPath The path to modules (JS).
 * @param {Record<string, string>} [specificRoute] The specific route of specific modules.
 * @param {boolean} [doRequire] If true, require() the module directly.
 * Otherwise, print out the module path. Default to true.
 * @returns {Promise<ModuleDefinition[]>} The module definitions.
 *
 * @example getModuleDefinitions("./module", {"album_new.js": "/album/create"})
 */
async function getModulesDefinitions(
  modulesPath,
  specificRoute,
  doRequire = true,
) {
  const files = await fs.promises.readdir(modulesPath)
  const parseRoute = (/** @type {string} */ fileName) =>
    specificRoute && fileName in specificRoute
      ? specificRoute[fileName]
      : `/${fileName.replace(/\.js$/i, '').replace(/_/g, '/')}`

  const modules = files
    .reverse()
    .filter((file) => file.endsWith('.js'))
    .map((file) => {
      const identifier = file.split('.').shift()
      const route = '/api' + parseRoute(file)
      const modulePath = path.join(modulesPath, file)
      const module = doRequire ? require(modulePath) : modulePath

      return {
        identifier,
        route,
        module,
      }
    })

  return modules
}

/**
 * Check if the version of this API is latest.
 *
 * @returns {Promise<VersionCheckResult>} If true, this API is up-to-date;
 * otherwise, this API should be upgraded and you would
 * need to notify users to upgrade it manually.
 */
async function checkVersion() {
  return new Promise((resolve) => {
    exec('npm info NeteaseCloudMusicApi version', (err, stdout) => {
      if (!err) {
        let version = stdout.trim()

        /**
         * @param {VERSION_CHECK_RESULT} status
         */
        const resolveStatus = (status) =>
          resolve({
            status,
            ourVersion: packageJSON.version,
            npmVersion: version,
          })

        resolveStatus(
          packageJSON.version < version
            ? VERSION_CHECK_RESULT.NOT_LATEST
            : VERSION_CHECK_RESULT.LATEST,
        )
      } else {
        resolve({
          status: VERSION_CHECK_RESULT.FAILED,
        })
      }
    })
  })
}

/**
 * Construct the server of NCM API.
 *
 * @param {ModuleDefinition[]} [moduleDefs] Customized module definitions [advanced]
 * @returns {Promise<import("express").Express>} The server instance.
 */
async function consturctServer(moduleDefs) {
  const app = express()
  const { CORS_ALLOW_ORIGIN } = process.env
  app.set('trust proxy', true)

  /**
   * Serving static files
   */
  app.use(express.static(path.join(__dirname, 'public')))
  /**
   * CORS & Preflight request
   */
  app.use((req, res, next) => {
    if (req.path !== '/' && !req.path.includes('.')) {
      res.set({
        'Access-Control-Allow-Credentials': true,
        'Access-Control-Allow-Origin':
          CORS_ALLOW_ORIGIN || req.headers.origin || '*',
        'Access-Control-Allow-Headers': 'X-Requested-With,Content-Type',
        'Access-Control-Allow-Methods': 'PUT,POST,GET,DELETE,OPTIONS',
        'Content-Type': 'application/json; charset=utf-8',
      })
    }
    req.method === 'OPTIONS' ? res.status(204).end() : next()
  })

  /**
   * Cookie Parser
   */
  app.use((req, _, next) => {
    req.cookies = {}
    //;(req.headers.cookie || '').split(/\s*;\s*/).forEach((pair) => { //  Polynomial regular expression //
    ;(req.headers.cookie || '').split(/;\s+|(?<!\s)\s+$/g).forEach((pair) => {
      let crack = pair.indexOf('=')
      if (crack < 1 || crack == pair.length - 1) return
      req.cookies[decode(pair.slice(0, crack)).trim()] = decode(
        pair.slice(crack + 1),
      ).trim()
    })
    next()
  })

  /**
   * Body Parser and File Upload
   */
  app.use(
    express.json({
      limit: '50mb',
    }),
  )
  app.use(
    express.urlencoded({
      extended: false,
      limit: '50mb',
    }),
  )

  app.use(fileUpload())

  /**
   * Cache
   */
  // app.use(cache('2 minutes', (_, res) => res.statusCode === 200))

  /**
   * 文件跨域
   */
  app.use('/api/song/asset/v1', async (req, res) => {
    const targetUrl = req.query.url
    if (!targetUrl) {
      return res.status(400).json({ error: 'Missing URL parameter' })
    }

    console.log(targetUrl)

    const parsedUrl = new URL(targetUrl)
    const transport = parsedUrl.protocol === 'https:' ? https : http

    const options = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
      path: parsedUrl.pathname + parsedUrl.search,
      method: 'GET',
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        Accept: '*/*',
        Connection: 'keep-alive',
        Range: 'bytes-0',
      },
    }

    try {
      const proxyReq = transport.request(options, (proxyRes) => {
        // 验证内容类型
        const contentType = proxyRes.headers['content-type'] || ''

        if (!contentType.includes('audio/mpeg')) {
          console.warn(`Unexpected content type: ${contentType}`)
        }

        // 设置响应头 - 关键：保持原始二进制数据
        res.set({
          'Content-Type': contentType || 'audio/mpeg',
          'Content-Length': proxyRes.headers['content-length'],
          'Accept-Ranges': 'bytes',
        })

        // 直接管道传输 - 避免任何中间处理
        proxyRes.pipe(res)
      })

      proxyReq.end()

      // const buffer = await downloadMP3(targetUrl, `./downloaded_audio_${Date.now()}.mp3`)

      // // console.log(buffer)
      // // console.log(buffer.length)
      // res.set(
      //   {
      //     'Content-Length': buffer.length,
      //     'Content-Disposition': 'inline; filename="audio.mp3"',
      //     'Content-Type': 'audio/mpeg;charset=UTF-8',
      //   }
      // )
      // console.log(res)
      // console.log('on write server')
      // res.send(buffer)
    } catch (error) {
      console.error(error)
    }
  })

  /**
   * Special Routers
   */
  const special = {
    'daily_signin.js': '/daily_signin',
    'fm_trash.js': '/fm_trash',
    'personal_fm.js': '/personal_fm',
  }

  /**
   * Load every modules in this directory
   */
  console.log(path.join(__dirname, './module'))
  const moduleDefinitions =
    moduleDefs ||
    (await getModulesDefinitions(path.join(__dirname, '../module'), special))

  for (const moduleDef of moduleDefinitions) {
    // Register the route.
    app.use(moduleDef.route, async (req, res) => {
      ;[req.query, req.body].forEach((item) => {
        if (typeof item.cookie === 'string') {
          item.cookie = cookieToJson(decode(item.cookie))
        }
      })

      let query = Object.assign(
        {},
        {
          cookie: req.cookies,
        },
        req.query,
        req.body,
        req.files,
      )

      try {
        const moduleResponse = await moduleDef.module(query, (...params) => {
          // 参数注入客户端IP
          const obj = [...params]
          let ip = req.ip || ''

          if (ip.substr(0, 7) == '::ffff:') {
            ip = ip.substr(7)
          }
          if (ip == '::1') {
            ip = global.cnIp
          }
          // console.log(ip)
          obj[3] = {
            ...obj[3],
            ip,
          }
          return request(...obj)
        })
        console.log('[OK]', decode(req.originalUrl))

        const cookies = moduleResponse.cookie
        if (!query.noCookie) {
          if (Array.isArray(cookies) && cookies.length > 0) {
            if (req.protocol === 'https') {
              // Try to fix CORS SameSite Problem
              res.append(
                'Set-Cookie',
                cookies.map((cookie) => {
                  return cookie + 'SameSite=None; Secure;'
                }),
              )
            } else {
              res.append('Set-Cookie', cookies)
            }
          }
        }
        res.status(moduleResponse.status).send(moduleResponse.body)
      } catch (/** @type {*} */ moduleResponse) {
        console.log('[ERR]', decode(req.originalUrl), {
          status: moduleResponse.status,
          body: moduleResponse.body,
        })
        if (!moduleResponse.body) {
          res.status(404).send({
            code: 404,
            data: null,
            msg: 'Not Found',
          })
          return
        }
        if (moduleResponse.body.code == '301')
          moduleResponse.body.msg = '需要登录'
        if (!query.noCookie) {
          res.append('Set-Cookie', moduleResponse.cookie)
        }

        res.status(moduleResponse.status).send(moduleResponse.body)
      }
    })
  }

  return app
}

/**
 * Serve the NCM API.
 * @param {NcmApiOptions} options
 * @returns {Promise<import('express').Express & ExpressExtension>}
 */
async function serveNcmApi(options) {
  const port = Number(options.port || process.env.PORT || '3000')
  const host = options.host || process.env.HOST || ''

  const checkVersionSubmission =
    options.checkVersion &&
    checkVersion().then(({ npmVersion, ourVersion, status }) => {
      if (status == VERSION_CHECK_RESULT.NOT_LATEST) {
        console.log(
          `最新版本: ${npmVersion}, 当前版本: ${ourVersion}, 请及时更新`,
        )
      }
    })
  const constructServerSubmission = consturctServer(options.moduleDefs)

  const [_, app] = await Promise.all([
    checkVersionSubmission,
    constructServerSubmission,
  ])

  /** @type {import('express').Express & ExpressExtension} */
  const appExt = app
  // appExt.server = app.listen(port, host, () => {
  //   console.log(`server running @ http://${host ? host : 'localhost'}:${port}`)
  // })

  return appExt
}

module.exports = {
  serveNcmApi,
  getModulesDefinitions,
}

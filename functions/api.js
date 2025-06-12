const fs = require('fs')
const path = require('path')
const tmpPath = require('os').tmpdir()
const serverless = require('serverless-http')

// const {
//   register_anonimous
// } = require('../main')
// const {
//   cookieToJson,
//   generateRandomChineseIP
// } = require('../util/index')

// async function generateConfig() {
//   global.cnIp = generateRandomChineseIP()
//   try {
//     const res = await register_anonimous()
//     const cookie = res.body.cookie
//     if (cookie) {
//       const cookieObj = cookieToJson(cookie)
//       fs.writeFileSync(
//         path.resolve(tmpPath, 'anonymous_token'),
//         cookieObj.MUSIC_A,
//         'utf-8',
//       )
//     }
//   } catch (error) {
//     console.log(error)
//   }
// }

module.exports.handler = async (...args) => {
  // 检测是否存在 anonymous_token 文件,没有则生成
  if (!fs.existsSync(path.resolve(tmpPath, 'anonymous_token'))) {
    fs.writeFileSync(path.resolve(tmpPath, 'anonymous_token'), '', 'utf-8')
  }
  // 启动时更新anonymous_token
  //   const generateConfig = require('../generateConfig')
  // await generateConfig()
  const app = await require('../server').serveNcmApi({
    checkVersion: false,
  })
  return serverless(app, {
    binary: ['application/json', 'image/*', 'audio/mpeg'],
  })(...args)
}

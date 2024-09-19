import { app, BrowserWindow, Menu, net, protocol } from 'electron'
import { release } from 'os'
import Constants from './utils/Constants'
import store from './store'
import { createTray, YPMTray } from './tray'
import { createMenu } from './menu'
import { createDockMenu } from './dock'
import { createTouchBar } from './touchBar'
import fastify, { FastifyInstance } from 'fastify'
import fastifyCookie from '@fastify/cookie'
import netease from './appServer/netease'
import IPCs from './IPCs'
import fastifyStatic from '@fastify/static'
// import fastifyCors from '@fastify/cors'
import path from 'path'
// import { pathToFileURL } from 'url'
import { parseFile, IAudioMetadata } from 'music-metadata'
import cache from './cache'
import {
  getReplayGainFromMetadata,
  getPic,
  getLyric,
  getPicColor,
  getTrackDetail,
  getAudioSource
} from './utils/utils'
import { CacheAPIs } from './utils/CacheApis'

const cacheTracks = new Map<string, any>()

class BackGround {
  win: BrowserWindow | null = null
  lyricWin: BrowserWindow | null = null
  tray: YPMTray | null = null
  menu: Menu | null = null
  fastifyApp: FastifyInstance | null = null
  willQuitApp: boolean = !Constants.IS_MAC

  async init() {
    if (release().startsWith('6.1')) app.disableHardwareAcceleration()
    if (process.platform === 'win32') app.setAppUserModelId(app.getName())
    if (!app.requestSingleInstanceLock()) {
      app.quit()
      process.exit(0)
    }

    protocol.registerSchemesAsPrivileged([
      {
        scheme: 'atom',
        // privileges: { secure: true, standard: true, supportFetchAPI: true }
        privileges: { secure: true, standard: true, supportFetchAPI: true, stream: true }
      },
      {
        scheme: 'media',
        privileges: { secure: true, standard: true, supportFetchAPI: true, stream: true }
      },
      {
        scheme: 'music',
        privileges: { secure: true, standard: true, supportFetchAPI: true, stream: true }
      }
    ])

    // create fastify app
    this.fastifyApp = await this.createFastifyApp()

    this.handleAppEvents()

    if (Constants.IS_LINUX) {
      app.commandLine.appendSwitch(
        'disable-features',
        'HardwareMediaKeyHandling,MediaSessionService'
      )
    }
  }

  async createFastifyApp() {
    const server = fastify({
      ignoreTrailingSlash: true
    })
    // server.register(fastifyCors, {
    //   origin: '*'
    // })
    server.register(fastifyCookie)
    server.register(fastifyStatic, {
      root: path.join(__dirname, '../')
    })
    server.register(netease)
    const port = Number(
      Constants.IS_DEV_ENV
        ? Constants.ELECTRON_DEV_NETEASE_API_PORT || 40001
        : Constants.ELECTRON_WEB_SERVER_PORT || 41830
    )
    await server.listen({ port })
    console.log(`AppServer is running at http://localhost:${port}`)
    return server
  }

  async createMainWindow() {
    const option = {
      title: Constants.APP_NAME,
      show: false,
      width: (store.get('window.width') as number) || 1080,
      height: (store.get('window.height') as number) || 720,
      x: (store.get('window.x') as number) || undefined,
      y: (store.get('window.y') as number) || undefined,
      minWidth: 1080,
      minHeight: 720,
      frames: false,
      useContentSize: true,
      titleBarStyle: 'hiddenInset' as const,
      webPreferences: Constants.DEFAULT_WEB_PREFERENCES
    }
    this.win = new BrowserWindow(option)
    this.win.setMenuBarVisibility(false)

    if (Constants.IS_DEV_ENV) {
      await this.win.loadURL(Constants.APP_INDEX_URL_DEV)
      this.win.webContents.openDevTools()
    } else {
      await this.win.loadURL(Constants.APP_INDEX_URL_PROD)
    }
  }

  async createOSDWindow() {
    const option = {
      title: '桌面歌词',
      show: false,
      width: (store.get('osdWindow.width') as number) || 840,
      height: (store.get('osdWindow.height') as number) || 480,
      x: (store.get('osdWindow.x') as number) || undefined,
      y: (store.get('osdWindow.y') as number) || undefined,
      transparent: true,
      frame: false,
      useContentSize: true,
      alwaysOnTop: (store.get('osdWindow.isAlwaysOnTop') as boolean) || false,
      hasShadow: false,
      hiddenInMissionControl: true,
      skipTaskbar: true,
      webPreferences: Constants.DEFAULT_OSD_PREFERENCES
    }
    this.lyricWin = new BrowserWindow(option)
    await this.lyricWin.loadURL(Constants.APP_OSD_URL)
  }

  toggleMouseIgnore() {
    const isLock = (store.get('osdWindow.isLock') as boolean) || false
    const isHoverHide = (store.get('osdWindow.isHoverHide') as boolean) || false
    this.lyricWin.setIgnoreMouseEvents(isLock, { forward: !Constants.IS_LINUX && isHoverHide })
    this.lyricWin.setVisibleOnAllWorkspaces(isLock)
  }

  toggleOSDWindowAlwaysOnTop() {
    const isAlwaysOnTop = (store.get('osdWindow.isAlwaysOnTop') as boolean) || false
    this.lyricWin.setAlwaysOnTop(isAlwaysOnTop)
  }

  handleLyricWindowPosition(position: { x: number; y: number }) {
    const data = this.lyricWin.getBounds()
    this.lyricWin.setPosition(data.x + position.x, data.y + position.y)
  }

  toggleOSDWindow() {
    const osdLyric = store.get('osdWindow.show') || false
    this.win.webContents.send('toggleOSDWindow', osdLyric)
    if (osdLyric) {
      this.showOSDWindow()
    } else {
      this.hideOSDWindow()
    }
  }

  sendLyricToOSDWindow(lyrics: { lyric: any[]; tlyric: any[]; rlyric: any[] }) {
    this.lyricWin?.webContents.send('updateLyric', lyrics)
  }

  sendLyricIndexToOSDWindow(index: number) {
    this.lyricWin?.webContents.send('updateLyricIndex', index)
  }

  handleOSDWindowEvents() {
    this.lyricWin.once('ready-to-show', () => {
      this.lyricWin.showInactive()
      this.toggleMouseIgnore()
    })
    this.lyricWin.on('resize', () => {
      const data = this.lyricWin.getBounds()
      store.set('osdWindow.width', data.width)
      store.set('osdWindow.height', data.height)
    })
    this.lyricWin.on('move', () => {
      const data = this.lyricWin.getBounds()
      store.set('osdWindow.x', data.x)
      store.set('osdWindow.y', data.y)
    })
  }

  hideOSDWindow() {
    if (this.lyricWin) {
      this.lyricWin.close()
      this.lyricWin = null
    }
  }

  showOSDWindow() {
    if (!this.lyricWin) {
      this.createOSDWindow()
      this.handleOSDWindowEvents()
    }
  }

  initOSDWindow() {
    const osd = store.get('osdWindow.show') || false
    if (osd) {
      this.showOSDWindow()
    }
  }

  handleProtocol() {
    protocol.handle('atom', async (request) => {
      const { host, pathname } = new URL(request.url)
      if (host === 'online-pic') {
        const url = pathname.slice(1).replace('http://', 'https://')
        return net.fetch(url)
      } else if (host === 'get-pic') {
        const ids = pathname.slice(1)
        const res = cache.get(CacheAPIs.Track, { ids })
        let track
        if (res) {
          track = res.songs[0]
        } else {
          const res = await getTrackDetail(ids)
          track = res.songs[0]
        }
        let url = track.album?.picUrl || track.al?.picUrl
        if (url.startsWith('http://')) {
          url = url.replace('http://', 'https://')
          url = `${url}?param=64y64`
        }
        let metadata = null

        if (track.isLocal) {
          metadata = await parseFile(decodeURI(track.filePath))
        }

        const result = await getPic(url, track.matched, metadata)

        const pic = result.pic
        const format = result.format

        return new Response(pic, { headers: { 'Content-Type': format } })
      } else if (host === 'get-pic-path') {
        const filePath = pathname.slice(1)
        const url = 'https://p2.music.126.net/UeTuwE7pvjBpypWLudqukA==/3132508627578625.jpg'
        const metadata = await parseFile(decodeURI(filePath))

        const result = await getPic(url, false, metadata)
        return new Response(result.pic, { headers: { 'Content-Type': result.format } })
      } else if (host === 'get-playlist-pic') {
        const ids = pathname.slice(1)
        const res = cache.get(CacheAPIs.Track, { ids })
        const track = res.songs[0]

        const url = track.matched
          ? track.album.picUrl + '?param=512y512'
          : 'https://p1.music.126.net/jWE3OEZUlwdz0ARvyQ9wWw==/109951165474121408.jpg?param=512y512'

        let metadata = null
        if (track.isLocal) {
          metadata = await parseFile(decodeURI(track.filePath))
        }

        const result = await getPic(url, track.matched, metadata)
        return new Response(result.pic, { headers: { 'Content-Type': result.format } })
      } else if (host === 'get-lyric') {
        const ids = pathname.slice(1)
        const res = cache.get(CacheAPIs.Track, { ids })
        let lyrics = {
          lrc: { lyric: [] },
          tlyric: { lyric: [] },
          romalrc: { lyric: [] }
        }

        if (res?.songs?.length > 0) {
          const track = res.songs[0]

          lyrics = await getLyric(track.id, track.matched, track.filePath)
        } else {
          lyrics = await getLyric(Number(ids), true, null)
        }

        return new Response(JSON.stringify(lyrics), {
          headers: { 'content-type': 'application/json' }
        })
      } else if (host === 'get-music') {
        const url = pathname.slice(1)
        return net.fetch(url)
      } else if (host === 'get-track-info') {
        const ids = pathname.slice(1)
        let track
        const res = cache.get(CacheAPIs.Track, { ids })
        if (res?.songs?.length > 0) {
          track = res.songs[0]
        } else {
          track = cacheTracks.get(ids)
          if (track) {
            cacheTracks.delete(ids)
          } else {
            const res = await getTrackDetail(ids)
            track = res.songs[0]
          }
          track.matched = true
        }

        let url = track.album?.picUrl || track.al?.picUrl
        if (url.startsWith('http://')) {
          url = url.replace('http://', 'https://')
        }
        url = `${url}?param=512y512`
        let metadata: IAudioMetadata | null = null

        // const useInnerFirst = store.get('settings.innerFirst') as boolean
        if (track.isLocal && !track.matched) {
          metadata = await parseFile(decodeURI(track.filePath))
        }

        // 获取歌词信息
        const paramForLocal = metadata ?? track.filePath ?? null
        const lyrics = await getLyric(track.id, track.matched, paramForLocal)

        // 获取封面
        const { pic, format } = await getPic(url, track.matched, metadata)

        // 获取颜色
        const { color, color2 } = await getPicColor(pic)

        const gain = getReplayGainFromMetadata(metadata)
        return new Response(JSON.stringify({ pic, format, color, color2, gain, lyrics }), {
          headers: { 'content-type': 'application/json' }
        })
      } else if (host === 'get-track') {
        const ids = pathname.slice(1)
        const res = cache.get(CacheAPIs.Track, { ids })
        if (res) {
          const track = res.songs[0]
          return new Response(JSON.stringify(track), {
            headers: { 'content-type': 'application/json' }
          })
        } else {
          const res = await getTrackDetail(ids)
          const track = res.songs[0]
          const url = await getAudioSource(track)
          track.url = url
          cacheTracks.set(ids, track)
          return new Response(JSON.stringify(track), {
            headers: { 'content-type': 'application/json' }
          })
        }
      } else if (host === 'get-color') {
        const url = pathname.slice(1)
        const { pic } = await getPic(url, true, null)
        const { color, color2 } = await getPicColor(pic)
        return new Response(JSON.stringify({ color, color2 }), {
          headers: { 'content-type': 'application/json' }
        })
      }
    })
    // 由于electron使用了handle来处理自定义协议之后会导致音频流和视频流文件的seek方法失效，暂时回退到使用registerFileProtocol来处理音频流文件
    // 待electron更新后再使用回handle
    protocol.registerFileProtocol('media', (request, callback) => {
      const { host, pathname } = new URL(request.url)
      if (host === 'get-music') {
        callback({ path: decodeURI(pathname.slice(1)) })
      }
    })
    protocol.registerHttpProtocol('music', (request, callback) => {
      const { host, pathname } = new URL(request.url)
      if (host === 'online-music') {
        const url = pathname.slice(1)
        callback({ url })
      }
    })
  }

  handleAppEvents() {
    app.whenReady().then(() => {
      // handle protocol
      this.handleProtocol()

      // create window
      this.createMainWindow()
      this.initOSDWindow()

      // window events
      this.handleWindowEvents()

      this.tray = createTray(this.win)
      createTouchBar(this.win)
      // this.mprs = createMpris(this.win)

      const lrc = {
        toggleOSDWindow: () => this.toggleOSDWindow(),
        toggleMouseIgnore: () => this.toggleMouseIgnore(),
        toggleOSDWindowAlwaysOnTop: () => this.toggleOSDWindowAlwaysOnTop(),
        updateLyric: (lrc: any) => this.sendLyricToOSDWindow(lrc),
        updateLyricIndex: (index: number) => this.sendLyricIndexToOSDWindow(index),
        handleLyricWindowPosition: (position: any) => this.handleLyricWindowPosition(position)
      }
      IPCs.initialize(this.win, this.lyricWin, this.tray, lrc)
      createMenu(this.win)
      createDockMenu(this.win)
    })

    app.on('activate', () => {
      if (this.win === null) {
        this.createMainWindow()
      } else {
        this.win.show()
      }
    })

    app.on('window-all-closed', () => {
      if (!Constants.IS_MAC) app.quit()
    })

    app.on('before-quit', () => {
      this.willQuitApp = true
    })

    app.on('quit', () => {
      this.fastifyApp?.close()
    })

    app.on('will-quit', () => {})

    if (!Constants.IS_MAC) {
      app.on('second-instance', () => {
        if (this.win) {
          this.win.show()
          if (this.win.isMinimized()) {
            this.win.restore()
          }
          this.win.focus()
        }
      })
    }
  }

  handleWindowEvents() {
    this.win.once('ready-to-show', () => {
      this.win.show()
      this.win.focus()
    })

    this.win.on('close', (e) => {
      if (Constants.IS_MAC) {
        if (this.willQuitApp) {
          this.win = null
          app.quit()
        } else {
          e.preventDefault()
          this.win.hide()
        }
      }
    })

    this.win.on('maximize', () => {
      this.win.webContents.send('isMaximized', true)
    })

    this.win.on('unmaximize', () => {
      this.win.webContents.send('isMaximized', false)
    })

    this.win.on('resize', () => {
      store.set('window', this.win.getBounds())
    })

    this.win.on('move', () => {
      const pos = this.win.getPosition()
      store.set('window.x', pos[0])
      store.set('window.y', pos[1])
    })
  }
}

const bgProcess = new BackGround()
bgProcess.init()
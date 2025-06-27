#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { readFile, appendFile } from 'node:fs/promises'
import path from 'node:path'
import { parseArgs as utilParseArgs } from 'node:util'

class LSPClient {
    constructor(debug = false) {
        this.debug = debug
        this.process = null
        this.messageId = 0
        this.buffer = ''
        this.responseHandlers = new Map()
        this.requestHandlers = new Map()
        this.notificationHandlers = new Map()
    }

    async start(command, args) {
        this.process = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] })
        this.process.stdout.on('data', data => this.handleData(data))
        this.process.stderr.on('data', data => this.log('error', data.toString()))
        this.log('start', `${command} ${args.join(' ')}`)
    }

    sendRequest(method, params) {
        return new Promise((resolve, reject) => {
            const id = ++this.messageId
            this.responseHandlers.set(id, { resolve, reject })
            this.send({ jsonrpc: '2.0', id, method, params })
        })
    }

    sendNotification(method, params) {
        this.send({ jsonrpc: '2.0', method, params })
    }

    send(message) {
        const content = JSON.stringify(message)
        const data = `Content-Length: ${Buffer.byteLength(content)}\r\n\r\n${content}`
        this.log('send', content)
        this.process.stdin.write(data)
    }

    onRequest(method, handler) { this.requestHandlers.set(method, handler) }
    onNotification(method, handler) { this.notificationHandlers.set(method, handler) }

    log(type, message) {
        if (this.debug) {
            const time = new Date().toISOString().slice(11, 19)
            appendFile('sonarlint-debug.log', `${time} ${type}: ${message}\n`).catch(() => {})
        }
    }

    handleData(data) {
        this.buffer += data.toString()
        this.log('recv', data.toString().trim())

        let match
        while ((match = this.buffer.match(/Content-Length: (\d+)\r\n\r\n/))) {
            const length = parseInt(match[1])
            const start = match.index + match[0].length

            if (this.buffer.length < start + length) break

            const content = this.buffer.slice(start, start + length)
            this.buffer = this.buffer.slice(start + length)

            try {
                const message = JSON.parse(content)
                if (message.id && this.responseHandlers.has(message.id)) {
                    const { resolve, reject } = this.responseHandlers.get(message.id)
                    this.responseHandlers.delete(message.id)
                    message.error ? reject(new Error(message.error.message)) : resolve(message.result)
                } else if (message.method) {
                    const handler = message.id ? this.requestHandlers.get(message.method) : this.notificationHandlers.get(message.method)
                    if (handler) {
                        const result = handler(message.params)
                        if (message.id) this.send({ jsonrpc: '2.0', id: message.id, result })
                    }
                }
            } catch (e) {
                console.error('Parse error:', e.message)
            }
        }
    }

    async stop() {
        if (this.process && !this.process.killed) {
            this.sendNotification('shutdown', {})
            this.sendNotification('exit', {})
            await new Promise(r => setTimeout(r, 100))
            this.process.kill()
        }
    }
}

class SonarLintClient {
    constructor(options) {
        this.lsp = new LSPClient(options.debug)
        this.java = options.java || 'java'
        this.jar = options.sonarlintLsp
        this.analyzers = options.analyzers || []
        this.enabledRules = options.enabledRules
        this.disabledRules = options.disabledRules
        this.rules = []
        this.diagnostics = new Set()
        this.errors = false
        this.pending = new Set()
        this.resolver = null

        this.lsp.onRequest('workspace/configuration', () => {
            const rules = {}
            for (const rule of this.rules) {
                rules[rule] = { level: this.disabledRules?.includes(rule) ? 'off' :
                    this.enabledRules ? (this.enabledRules.includes(rule) ? 'on' : 'off') : 'on' }
            }
            return [{ rules }]
        })

        this.lsp.onRequest('sonarlint/isOpenInEditor', () => true)
        this.lsp.onNotification('textDocument/publishDiagnostics', params => this.handleDiagnostics(params))
    }

    async start() {
        await this.lsp.start(this.java, ['-jar', this.jar, '-stdio', '-analyzers', ...this.analyzers])

        await this.lsp.sendRequest('initialize', { initializationOptions: { productKey: '', productVersion: '' } })
        this.lsp.sendNotification('initialized', {})
        this.lsp.sendNotification('workspace/didChangeConfiguration', {})

        const response = await this.lsp.sendRequest('sonarlint/listAllRules')
        this.rules = Object.values(response || {}).flat().map(rule => rule.key)
    }

    handleDiagnostics(params) {
        const file = params.uri.replace('file://', '')

        for (const diag of params.diagnostics) {
            const line = diag.range.start.line + 1
            const col = diag.range.start.character + 1
            const msg = `${file}:${line}:${col} - ${diag.message} (${diag.code})`

            if (!this.diagnostics.has(msg)) {
                this.diagnostics.add(msg)
                console.log(msg)
                this.errors = true
            }
        }

        this.pending.delete(file)
        if (this.pending.size === 0 && this.resolver) {
            this.resolver()
        }
    }

    async analyzeFiles(files, options = {}) {
        this.enabledRules = options.rules
        this.disabledRules = options.disableRules
        this.diagnostics.clear()
        this.pending.clear()
        this.errors = false

        for (const file of files) {
            const content = await readFile(file, 'utf8')
            const uri = `file://${path.resolve(file)}`
            this.pending.add(uri.replace('file://', ''))

            this.lsp.sendNotification('textDocument/didOpen', {
                textDocument: { uri, text: content, languageId: 'javascript', version: 1 }
            })
        }

        if (this.pending.size > 0) {
            await new Promise(resolve => { this.resolver = resolve })
        }
    }

    async listRules() { return this.rules }
    async stop() { await this.lsp.stop() }
}

async function main() {
    const { values, positionals } = utilParseArgs({
        options: {
            debug: { type: 'boolean', default: false },
            java: { type: 'string', default: 'java' },
            analyzers: { type: 'string', multiple: true },
            rules: { type: 'string' },
            'sonarlint-lsp': { type: 'string' },
            'disable-rules': { type: 'string' },
        },
        allowPositionals: true
    })

    const [command, ...files] = positionals

    if (!command || !['list-rules', 'analyze'].includes(command)) {
        console.error('Error: Use "list-rules" or "analyze"')
        process.exit(1)
    }

    if (command === 'analyze' && files.length === 0) {
        console.error('Error: Files required for analyze')
        process.exit(1)
    }

    const client = new SonarLintClient({
        debug: values.debug,
        java: values.java,
        sonarlintLsp: values['sonarlint-lsp'] || './sonarlint-deps/server/sonarlint-lsp.jar',
        analyzers: values.analyzers?.length ? values.analyzers : ['./sonarlint-deps/analyzers/sonarjs.jar'],
        enabledRules: values.rules?.split(','),
        disabledRules: values['disable-rules']?.split(','),
    })

    try {
        await client.start()

        if (command === 'list-rules') {
            console.log((await client.listRules()).join(','))
        } else {
            await client.analyzeFiles(files, {
                rules: client.enabledRules,
                disableRules: client.disabledRules,
            })
        }

        await client.stop()
        process.exit(client.errors ? 1 : 0)
    } catch (error) {
        console.error('Error:', error.message)
        await client.stop()
        process.exit(1)
    }
}

main().catch(console.error)

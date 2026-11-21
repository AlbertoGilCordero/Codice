const pdfjsPath = path => new URL(`vendor/pdfjs/${path}`, import.meta.url).toString()

import './vendor/pdfjs/pdf.mjs'
const pdfjsLib = globalThis.pdfjsLib
pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsPath('pdf.worker.mjs')

const fetchText = async url => await (await fetch(url)).text()

// https://raw.githubusercontent.com/mozilla/pdf.js/refs/tags/v5.5.207/web/text_layer_builder.css
const textLayerBuilderCSS = await fetchText(pdfjsPath('text_layer_builder.css'))

// https://raw.githubusercontent.com/mozilla/pdf.js/refs/tags/v5.5.207/web/annotation_layer_builder.css
const annotationLayerBuilderCSS = await fetchText(pdfjsPath('annotation_layer_builder.css'))

// caja de contenido de una página (sin márgenes en blanco), en unidades de página
const contentBox = async page => {
    const s = 0.3
    const vp = page.getViewport({ scale: s })
    const c = document.createElement('canvas')
    c.width = Math.ceil(vp.width)
    c.height = Math.ceil(vp.height)
    const ctx = c.getContext('2d', { willReadFrequently: true })
    await page.render({ canvasContext: ctx, viewport: vp }).promise
    const { data, width: w, height: h } = ctx.getImageData(0, 0, c.width, c.height)
    const r0 = data[0], g0 = data[1], b0 = data[2]
    let x0 = w, y0 = h, x1 = -1, y1 = -1
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4
        if (Math.abs(data[i] - r0) + Math.abs(data[i + 1] - g0) + Math.abs(data[i + 2] - b0) > 70) {
            if (x < x0) x0 = x
            if (x > x1) x1 = x
            if (y < y0) y0 = y
            if (y > y1) y1 = y
        }
    }
    if (x1 < 0) return null
    return { x0: x0 / s, y0: y0 / s, x1: (x1 + 1) / s, y1: (y1 + 1) / s }
}

const render = async (page, doc, zoom, crop) => {
    const scale = zoom * devicePixelRatio
    doc.documentElement.style.transform = `scale(${1 / devicePixelRatio})`
    doc.documentElement.style.transformOrigin = 'top left'
    doc.documentElement.style.setProperty('--scale-factor', scale)
    const fullViewport = page.getViewport({ scale })
    const viewport = crop ? page.getViewport({ scale, offsetX: -crop.x * scale, offsetY: -crop.y * scale }) : fullViewport
    if (crop) {
        viewport.width = crop.w * scale
        viewport.height = crop.h * scale
        const inset = `${-crop.y * scale}px auto auto ${-crop.x * scale}px`
        doc.querySelector('.textLayer').style.inset = inset
        doc.querySelector('.annotationLayer').style.inset = inset
    }

    // the canvas must be in the `PDFDocument`'s `ownerDocument`
    // (`globalThis.document` by default); that's where the fonts are loaded
    const canvas = document.createElement('canvas')
    canvas.height = viewport.height
    canvas.width = viewport.width
    const canvasContext = canvas.getContext('2d')
    await page.render({ canvasContext, viewport }).promise
    doc.querySelector('#canvas').replaceChildren(doc.adoptNode(canvas))

    const container = doc.querySelector('.textLayer')
    const textLayer = new pdfjsLib.TextLayer({
        textContentSource: await page.streamTextContent(),
        container, viewport: fullViewport,
    })
    await textLayer.render()

    // hide "offscreen" canvases appended to docuemnt when rendering text layer
    // https://github.com/mozilla/pdf.js/blob/642b9a5ae67ef642b9a8808fd9efd447e8c350e2/web/pdf_viewer.css#L51-L58
    for (const canvas of document.querySelectorAll('.hiddenCanvasElement'))
        Object.assign(canvas.style, {
            position: 'absolute',
            top: '0',
            left: '0',
            width: '0',
            height: '0',
            display: 'none',
        })

    // fix text selection
    // https://github.com/mozilla/pdf.js/blob/642b9a5ae67ef642b9a8808fd9efd447e8c350e2/web/text_layer_builder.js#L105-L107
    const endOfContent = document.createElement('div')
    endOfContent.className = 'endOfContent'
    container.append(endOfContent)
    // TODO: this only works in Firefox; see https://github.com/mozilla/pdf.js/pull/17923
    container.onpointerdown = () => container.classList.add('selecting')
    container.onpointerup = () => container.classList.remove('selecting')

    doc.__codice = { textLength: container.textContent.trim().length }
    doc.dispatchEvent(new CustomEvent('codice-rendered'))

    const div = doc.querySelector('.annotationLayer')
    const linkService = {
        goToDestination: () => {},
        getDestinationHash: dest => JSON.stringify(dest),
        addLinkAttributes: (link, url) => link.href = url,
    }
    await new pdfjsLib.AnnotationLayer({ page, viewport: fullViewport, div, linkService })
        .render({ annotations: await page.getAnnotations() })
}

const renderPage = async (page, getImageBlob, crop) => {
    const viewport = page.getViewport({ scale: 1 })
    const boxW = crop ? crop.w : viewport.width, boxH = crop ? crop.h : viewport.height
    if (getImageBlob) {
        const canvas = document.createElement('canvas')
        canvas.height = viewport.height
        canvas.width = viewport.width
        const canvasContext = canvas.getContext('2d')
        await page.render({ canvasContext, viewport }).promise
        return new Promise(resolve => canvas.toBlob(resolve))
    }
    const src = URL.createObjectURL(new Blob([`
        <!DOCTYPE html>
        <html lang="en">
        <meta charset="utf-8">
        <meta name="viewport" content="width=${boxW}, height=${boxH}">
        <style>
        html, body {
            margin: 0;
            padding: 0;
        }
        /*
        https://github.com/mozilla/pdf.js/commit/bd05b255fabfc313b194bfe9a17ccded4d90fb5a
        */
        :root {
          --user-unit: 1;
          --total-scale-factor: calc(var(--scale-factor) * var(--user-unit));
          --scale-round-x: 1px;
          --scale-round-y: 1px;
        }
        ${textLayerBuilderCSS}
        ${annotationLayerBuilderCSS}
        </style>
        <div id="canvas"></div>
        <div class="textLayer"></div>
        <div class="annotationLayer"></div>
    `], { type: 'text/html' }))
    const onZoom = ({ doc, scale }) => render(page, doc, scale, crop)
    return { src, onZoom }
}

const makeTOCItem = item => ({
    label: item.title,
    href: JSON.stringify(item.dest),
    subitems: item.items.length ? item.items.map(makeTOCItem) : null,
})

export const makePDF = async file => {
    const transport = new pdfjsLib.PDFDataRangeTransport(file.size, [])
    transport.requestDataRange = (begin, end) => {
        file.slice(begin, end).arrayBuffer().then(chunk => {
            transport.onDataRange(begin, chunk)
        })
    }
    const pdf = await pdfjsLib.getDocument({
        range: transport,
        cMapUrl: pdfjsPath('cmaps/'),
        standardFontDataUrl: pdfjsPath('standard_fonts/'),
        isEvalSupported: false,
    }).promise

    const book = { rendition: { layout: 'pre-paginated', spread: 'none' } }

    const { metadata, info } = await pdf.getMetadata() ?? {}
    // TODO: for better results, parse `metadata.getRaw()`
    book.metadata = {
        title: metadata?.get('dc:title') ?? info?.Title,
        author: metadata?.get('dc:creator') ?? info?.Author,
        contributor: metadata?.get('dc:contributor'),
        description: metadata?.get('dc:description') ?? info?.Subject,
        language: metadata?.get('dc:language'),
        publisher: metadata?.get('dc:publisher'),
        subject: metadata?.get('dc:subject'),
        identifier: metadata?.get('dc:identifier'),
        source: metadata?.get('dc:source'),
        rights: metadata?.get('dc:rights'),
    }

    const outline = await pdf.getOutline()
    book.toc = outline?.map(makeTOCItem)

    const cache = new Map()
    // recorte de márgenes: caja común del libro (muestreando páginas) + ajuste por página
    let bookBox
    const getBookBox = () => bookBox ??= (async () => {
        const n = pdf.numPages
        const picks = [...new Set([.12, .3, .5, .7, .88].map(f => Math.min(n, Math.max(1, Math.round(n * f)))))]
        let W = 0, T = Infinity, B = 0
        for (const k of picks) {
            const b = await contentBox(await pdf.getPage(k)).catch(() => null)
            if (b) { W = Math.max(W, b.x1 - b.x0); T = Math.min(T, b.y0); B = Math.max(B, b.y1) }
        }
        return { W, T, B }
    })()
    const cropFor = async page => {
        try {
            const own = await contentBox(page)
            if (!own) return null
            const bk = await getBookBox()
            const { width: PW, height: PH } = page.getViewport({ scale: 1 })
            const pad = PW * 0.025
            const w = Math.min(PW, Math.max(own.x1 - own.x0, bk.W) + 2 * pad)
            const x = Math.max(0, Math.min(PW - w, (own.x0 + own.x1) / 2 - w / 2))
            const y0 = Math.max(0, Math.min(own.y0, bk.T) - pad)
            const y1 = Math.min(PH, Math.max(own.y1, bk.B) + pad)
            if (w > PW * 0.95 && y1 - y0 > PH * 0.95) return null
            return { x, y: y0, w, h: y1 - y0 }
        } catch { return null }
    }
    book.sections = Array.from({ length: pdf.numPages }).map((_, i) => ({
        id: i,
        load: async () => {
            const on = !!globalThis.__codiceCrop, key = i + (on ? 'c' : 'f')
            const cached = cache.get(key)
            if (cached) return cached
            const page = await pdf.getPage(i + 1)
            const url = await renderPage(page, false, on ? await cropFor(page) : null)
            cache.set(key, url)
            return url
        },
        size: 1000,
    }))
    book.isExternal = uri => /^\w+:/i.test(uri)
    book.resolveHref = async href => {
        const parsed = JSON.parse(href)
        const dest = typeof parsed === 'string'
            ? await pdf.getDestination(parsed) : parsed
        const index = await pdf.getPageIndex(dest[0])
        return { index }
    }
    book.splitTOCHref = async href => {
        const parsed = JSON.parse(href)
        const dest = typeof parsed === 'string'
            ? await pdf.getDestination(parsed) : parsed
        const index = await pdf.getPageIndex(dest[0])
        return [index, null]
    }
    book.getTOCFragment = doc => doc.documentElement
    book.getCover = async () => renderPage(await pdf.getPage(1), true)
    book.getSectionText = async i => {
        const page = await pdf.getPage(i + 1)
        const tc = await page.getTextContent()
        return tc.items.map(x => x.str + (x.hasEOL ? '\n' : '')).join(' ')
    }
    book.destroy = () => pdf.destroy()
    return book
}

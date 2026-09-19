- renderView
    - PDFThumbnailViewer.forceRendering
    - PDFViewer.forceRendering

- renderHighestPriority
    - PDFRenderingQueue.renderView
    - PDFThumbnailViewer.#scrollUpdate
    - PDFViewer.update
    - PDFViewer.#switchToEditAnnotationMode

- getHighestPriority

- PDFViewer.update
    - set PDFViewer.pagesRotation
    - PDFViewer.setDocument: wait for the first page to get downloaded then render it
    - PDFViewer._scrollUpdate
    - PDFViewer.scrollIntoView
    - PDFViewer.#setScaleUpdatePages
    - PDFViewer._updateScrollMode
    - PDFViewer._updateSpreadMode
    - PDFViewer.refresh

- PDFViewer.forceRendering
    - PDFViewer.onPagesEdited
    - PDFRenderingQueue.renderHighestPriority

- PDFViewer accept `abortSignal` option that is used to:
    - disconnect and remove resizeObserver on abort
    - remove scroll event listener on abort
    - cancel animation frame on abort

- Flow for when a scroll happens
    - scroll event
    - call requestAnimationFrame
    - update scroll position
    - call PDFViewer._scrollUpdate (the callback passed into watchScroll)
    - PDFViewer.update
        1. get visible page - PDFViewer._getVisiblePages
        2. call PDFRenderingQueue.renderHighestPriority
        3. call PDFViewer.forceRendering
        4. call PDFRenderingQueue.getHighestPriority
        5. call PDFViewer.#ensurePdfPageLoaded
        6. call PDFRenderingQueue.renderView
        8. loop to 2 until no more page to be renderred
    - This flow doesn't use async/await, by doing this, all synchronous operations will block requestAnimationFrame and main thread once the callback being triggered, only the actuall rendering operations (the draw function) use async. This mean that when scroll state changed, the only window for this change to get effected is `after calculate which page to render and before that page actually got render` and `after the previous page finish render`
    - This flow only render one page at one time and use the finally branch of a promise as a loop to find if it should render a new page

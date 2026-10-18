/**
 * Minimal React hook runtime for exercising the shipped Client bundle in Node.
 *
 * It implements exactly the hooks `client.js` uses — `createElement`,
 * `useState`, `useEffect` (dependency-aware, so a poll loop really restarts),
 * and `useMemo` — without a DOM or a React installation, and returns plain
 * element trees the tests can walk.
 *
 * Hook state is kept per component function, the way React keeps it per fiber:
 * one runtime can render several components of the same bundle without their
 * hook slots colliding.
 *
 * @module dsh-usage-lens/test/hooks
 */

export function createHooks() {
  /** component function -> { cells, deps, cleanups, cursor, pending } */
  const fibers = new Map()
  let current

  function fiberFor(component) {
    let fiber = fibers.get(component)
    if (fiber === undefined) {
      fiber = { cells: [], deps: [], cleanups: new Map(), cursor: 0, pending: [] }
      fibers.set(component, fiber)
    }
    return fiber
  }

  const React = {
    createElement(type, props, ...children) {
      return {
        type,
        props: props ?? {},
        children: children
          .flat(Infinity)
          .filter((child) => child !== null && child !== undefined && child !== false && child !== true),
      }
    },
    useState(initial) {
      const fiber = current
      const index = fiber.cursor++
      if (!(index in fiber.cells)) fiber.cells[index] = initial
      return [fiber.cells[index], (next) => {
        fiber.cells[index] = typeof next === 'function' ? next(fiber.cells[index]) : next
      }]
    },
    useMemo(factory) {
      current.cursor += 1
      return factory()
    },
    useEffect(callback, deps) {
      const fiber = current
      const index = fiber.cursor++
      const previous = fiber.deps[index]
      const changed = previous === undefined
        || deps === undefined
        || deps.length !== previous.length
        || deps.some((value, offset) => !Object.is(value, previous[offset]))
      fiber.deps[index] = deps
      if (changed) fiber.pending.push({ index, callback })
    },
  }

  return {
    React,
    /** Render one component pass; returns the element tree. */
    render(component, props) {
      const fiber = fiberFor(component)
      current = fiber
      fiber.cursor = 0
      fiber.pending = []
      try {
        return component(props ?? {})
      } finally {
        current = undefined
      }
    },
    /**
     * Run the effects whose dependencies changed in the last render.
     * @param component - restrict to one component; omit to run every pending one.
     */
    async runEffects(component) {
      const targets = component === undefined ? [...fibers.values()] : [fiberFor(component)]
      for (const fiber of targets) {
        const ran = fiber.pending
        fiber.pending = []
        for (const { index, callback } of ran) {
          const previous = fiber.cleanups.get(index)
          if (typeof previous === 'function') previous()
          const cleanup = await callback()
          if (typeof cleanup === 'function') fiber.cleanups.set(index, cleanup)
          else fiber.cleanups.delete(index)
        }
      }
    },
    /** Tear down every effect of one component, or all of them. */
    dispose(component) {
      const targets = component === undefined ? [...fibers.values()] : [fiberFor(component)]
      for (const fiber of targets) {
        for (const cleanup of fiber.cleanups.values()) if (typeof cleanup === 'function') cleanup()
        fiber.cleanups.clear()
      }
    },
    /** Snapshot of one component's hook state cells, for diagnosing a mismatch. */
    debugCells(component) {
      return [...fiberFor(component).cells]
    },
  }
}

/** All text below one element, in order. */
export function flattenText(node) {
  if (node === null || node === undefined || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(flattenText).join('')
  return (node.children ?? []).map(flattenText).join('')
}

/** First element carrying one class name. */
export function findByClass(node, className) {
  if (node === null || typeof node !== 'object') return undefined
  if (node.props?.className === className) return node
  for (const child of node.children ?? []) {
    const hit = findByClass(child, className)
    if (hit !== undefined) return hit
  }
  return undefined
}

/** Every element carrying one class name, in tree order. */
export function findAllByClass(node, className, found = []) {
  if (node === null || typeof node !== 'object') return found
  if (node.props?.className === className) found.push(node)
  for (const child of node.children ?? []) findAllByClass(child, className, found)
  return found
}

/** Every element with one attribute set, in tree order. */
export function findAllByAttr(node, name, found = []) {
  if (node === null || typeof node !== 'object') return found
  if (node.props?.[name] !== undefined) found.push(node)
  for (const child of node.children ?? []) findAllByAttr(child, name, found)
  return found
}

/**
 * Install the browser globals the bundle expects.
 * @returns the recorded style tags and a listener registry.
 */
export function installBrowser() {
  const styles = []
  const listeners = new Map()

  const document = {
    visibilityState: 'visible',
    head: {
      appendChild(element) {
        styles.push(element)
      },
    },
    createElement() {
      const element = {
        dataset: {},
        textContent: '',
        removed: false,
        remove() {
          element.removed = true
        },
      }
      return element
    },
    addEventListener(name, listener) {
      listeners.set(name, listener)
    },
    removeEventListener(name) {
      listeners.delete(name)
    },
  }

  globalThis.document = document
  globalThis.window = {
    __ModuleLoader__: {
      load(definition) {
        globalThis.__usageLensDefinition = definition
      },
    },
    document,
    // Honor the real poll delay so a test never spins, and unref so a pending
    // poll cannot hold the process open.
    setTimeout(callback, delay) {
      const handle = setTimeout(callback, delay)
      handle.unref?.()
      return handle
    },
    clearTimeout(handle) {
      clearTimeout(handle)
    },
  }

  return { styles, listeners }
}

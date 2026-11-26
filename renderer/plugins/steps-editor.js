// The session dialog's list of launch steps: one row per step (its plugin's
// own controls and a delete button), and "+ Add" with the plugins that are
// available after the last step. Renderer only; the rules live in
// launch-core.js.
;(() => {
  const launch = window.zbtermLaunch

  // `opts`: { steps (plugin instances), env, invoke(method, args), showError,
  // name(), shown(Plugin), onPlugins() }. `name()` is the profile's name as
  // typed, for the placeholders (launch-core.js profileVars); `shown` says
  // whether "+ Add" offers a plugin (the Plugins dialog's choice); with
  // `onPlugins` the menu ends in "Plugins…", which calls it.
  function createStepsEditor(opts = {}) {
    const document = window.document
    const steps = opts.steps ? [...opts.steps] : []
    let env = opts.env || {}
    const invoke = opts.invoke
    const showError = opts.showError || (() => {})
    const nameOf = opts.name || (() => '')
    const shown = opts.shown || (() => true)
    const onPlugins = opts.onPlugins || null
    // The chain's env with this profile's placeholders filled in.
    const named = () => launch.withName(env, nameOf())

    const root = document.createElement('div')
    root.className = 'launch-steps'
    const rows = document.createElement('div')
    rows.className = 'launch-step-rows'
    const footer = document.createElement('div')
    footer.className = 'launch-steps-footer'
    const add = document.createElement('button')
    add.type = 'button'
    add.className = 'text-btn launch-add'
    add.innerHTML = '<i class="fa-solid fa-plus" aria-hidden="true"></i> Add'
    add.setAttribute('aria-haspopup', 'menu')
    const menu = document.createElement('div')
    menu.className = 'launch-add-menu'
    menu.setAttribute('role', 'menu')
    menu.hidden = true
    const error = document.createElement('div')
    error.className = 'launch-steps-error'
    error.hidden = true
    footer.append(add, menu)
    root.append(rows, footer, error)

    let serial = 0
    const removeButtons = new Map()

    const run = (action) => {
      Promise.resolve()
        .then(action)
        .catch((err) => showError(err))
    }

    function el(tag, className, text, children) {
      const node = document.createElement(tag)
      if (className) node.className = className
      if (text !== undefined && text !== null) node.textContent = text
      if (children) node.append(...children)
      return node
    }

    function button({ text, icon, title, className, onClick }) {
      const node = el('button', `text-btn ${className || ''}`.trim())
      node.type = 'button'
      if (icon) {
        const mark = el('i', `fa-solid ${icon}`)
        mark.setAttribute('aria-hidden', 'true')
        node.append(mark)
      }
      if (text) node.append(el('span', null, text))
      if (title) {
        node.title = title
        node.setAttribute('aria-label', title)
      }
      if (onClick) node.addEventListener('click', () => run(onClick))
      return node
    }

    // The toolkit a plugin builds its controls with (LaunchPlugin.getUI).
    function toolkit(step) {
      const kit = {
        document,
        el,
        button,
        // The context this step runs in, as the chain stands right now.
        context: () => {
          const at = steps.indexOf(step)
          return launch.contextAt(steps, at < 0 ? steps.length : at, env)
        },
        // The step's settings changed.
        changed: () => refresh(),
        // A plugin's main-process function (its static `host`).
        host: (plugin, method, args) => invoke('app.launchPlugin', { plugin, method, args }),
        chooseDirectory: (defaultPath) => invoke('app.chooseDirectory', { defaultPath }),
        showError,
        input({ name, placeholder, value, onInput, className }) {
          const node = el('input', `modal-input ${className || ''}`.trim())
          node.id = `launchField${++serial}`
          node.name = name || ''
          node.placeholder = placeholder || ''
          node.autocomplete = 'off'
          node.spellcheck = false
          node.value = value || ''
          node.addEventListener('input', () => {
            if (onInput) onInput(node.value)
            refresh()
          })
          return node
        },
        iconButton({ icon, title, onClick }) {
          return button({ icon, title, onClick, className: 'session-editor-browse' })
        },
        // Sets a field as if it had been typed into.
        setValue(node, value) {
          node.value = value
          node.dispatchEvent(new window.Event('input', { bubbles: true }))
        },
        // A text field with a list of suggestions under it, filtered by what
        // is typed. `items()` resolves to [{ value, label?, detail? }] and is
        // asked once, the first time the list opens. Typing opens the list;
        // Down moves into it (and opens it), Up and Down walk it, Enter or
        // Tab takes the suggestion, Escape closes it.
        combo({ name, placeholder, value, onInput, className, items }) {
          const input = kit.input({ name, placeholder, value, onInput, className })
          input.setAttribute('role', 'combobox')
          input.setAttribute('aria-autocomplete', 'list')
          input.setAttribute('aria-expanded', 'false')
          const list = el('div', 'launch-combo-list')
          list.setAttribute('role', 'listbox')
          list.hidden = true
          const wrap = el('div', 'launch-combo', null, [input, list])
          let loading = null
          let picking = false
          const load = () => {
            if (!loading) {
              loading = Promise.resolve()
                .then(() => (items ? items() : []))
                .then((all) => (Array.isArray(all) ? all : []))
                .catch(() => [])
            }
            return loading
          }
          const hide = () => {
            list.hidden = true
            input.setAttribute('aria-expanded', 'false')
          }
          const pick = (item) => {
            picking = true
            kit.setValue(input, item.value)
            picking = false
            hide()
            input.focus()
          }
          // `typed`: opened by typing, so a list holding only what is
          // already there has nothing to offer.
          const show = async (typed) => {
            const all = await load()
            const term = input.value.trim().toLowerCase()
            const matches = all.filter((item) =>
              [item.label, item.value, item.detail].some(
                (text) => text && String(text).toLowerCase().includes(term)
              )
            )
            const pointless = typed && matches.length === 1 && matches[0].value === input.value
            list.replaceChildren(
              ...matches.map((item) => {
                const option = el('button', 'launch-combo-item', null, [
                  el('span', 'launch-combo-name', item.label || item.value)
                ])
                if (item.detail) option.append(el('span', 'launch-combo-detail', item.detail))
                option.type = 'button'
                option.tabIndex = -1
                option.setAttribute('role', 'option')
                option.dataset.value = item.value
                option.addEventListener('mousedown', (event) => event.preventDefault())
                option.addEventListener('click', () => pick(item))
                option._item = item
                return option
              })
            )
            list.hidden = !matches.length || pointless || !wrap.contains(document.activeElement)
            input.setAttribute('aria-expanded', String(!list.hidden))
            return !list.hidden
          }
          input.addEventListener('input', () => {
            if (!picking) show(true)
          })
          input.addEventListener('keydown', (event) => {
            if (event.key === 'ArrowDown') {
              event.preventDefault()
              show(false).then((open) => {
                if (open) list.firstElementChild.focus()
              })
            } else if (event.key === 'Escape' && !list.hidden) {
              // The dialog's own Escape would close the whole dialog.
              event.preventDefault()
              event.stopPropagation()
              hide()
            }
          })
          list.addEventListener('keydown', (event) => {
            const options = Array.from(list.children)
            const at = options.indexOf(document.activeElement)
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault()
              const step = event.key === 'ArrowDown' ? 1 : -1
              if (at + step < 0) input.focus()
              else options[Math.min(options.length - 1, at + step)].focus()
            } else if (event.key === 'Enter' || event.key === 'Tab') {
              event.preventDefault()
              event.stopPropagation()
              if (at >= 0) pick(options[at]._item)
            } else if (event.key === 'Escape') {
              event.preventDefault()
              event.stopPropagation()
              hide()
              input.focus()
            }
          })
          wrap.addEventListener('focusout', (event) => {
            if (!wrap.contains(event.relatedTarget)) hide()
          })
          return wrap
        },
        // Controls side by side, the first one taking the room.
        row: (...children) => el('div', 'launch-row', null, children),
        // Controls one under the other.
        stack: (...children) => el('div', 'launch-stack', null, children)
      }
      return kit
    }

    function render() {
      closeMenu()
      removeButtons.clear()
      rows.replaceChildren()
      const { trace } = launch.run(steps, env)
      steps.forEach((step, index) => {
        const Plugin = step.constructor
        const row = el('div', 'launch-step')
        row.dataset.plugin = Plugin.id
        row.dataset.index = String(index)
        row.dataset.scope = trace[index].kind
        // Indented once per scope the step runs inside (SSH, a wrapper).
        row.dataset.depth = String(trace[index].depth - 1)
        row.style.setProperty('--launch-depth', String(trace[index].depth - 1))
        const label = el('label', 'session-editor-label', `${step.label()}:`)
        const body = el('div', 'launch-step-body')
        const controls = step.getUI(toolkit(step)) || el('span')
        controls.classList.add('launch-step-controls')
        const field = controls.matches('input, select, textarea')
          ? controls
          : controls.querySelector('input, select, textarea')
        if (field) label.htmlFor = field.id
        const remove = button({
          icon: 'fa-trash-can',
          className: 'session-editor-browse launch-step-remove',
          onClick: () => removeStep(steps.indexOf(step))
        })
        removeButtons.set(step, remove)
        body.append(controls, remove)
        row.append(label, body)
        rows.append(row)
      })
      refresh()
    }

    // What depends on the chain but must not rebuild the rows (a rebuild
    // would take the focus out of the field being typed in).
    function refresh() {
      steps.forEach((step, index) => {
        const remove = removeButtons.get(step)
        if (!remove) return
        const allowed = launch.canRemove(steps, index, env)
        const title = allowed
          ? `Delete ${step.constructor.title}`
          : 'Delete the steps after this one first'
        remove.disabled = !allowed
        remove.title = title
        remove.setAttribute('aria-label', title)
      })
      // "Plugins…" is always there to open, so the button stays usable.
      add.disabled = !onPlugins && offered().length === 0
      add.title = add.disabled ? 'Nothing can be added after the last step' : 'Add a step'
      setError('')
    }

    function setError(message) {
      error.textContent = message || ''
      error.hidden = !message
    }

    function closeMenu() {
      menu.hidden = true
      menu.replaceChildren()
      add.setAttribute('aria-expanded', 'false')
      document.removeEventListener('scroll', onScroll, true)
    }

    // 261121_dialog-and-command-plugins C7: the dialog scrolls when taller
    // than the window, which would clip a menu inside it; the menu is placed
    // on the window instead, under "+ Add" (above it when there is no room),
    // and a scroll closes it rather than leave it behind.
    function placeMenu() {
      const win = document.defaultView || window
      const at = add.getBoundingClientRect()
      menu.style.position = 'fixed'
      menu.style.left = `${Math.round(Math.max(8, at.left))}px`
      const height = menu.offsetHeight
      const below = at.bottom + 4
      const above = at.top - height - 4
      const top = below + height > win.innerHeight - 8 && above >= 8 ? above : below
      menu.style.top = `${Math.round(Math.max(8, top))}px`
    }

    function onScroll(event) {
      if (!menu.hidden && !menu.contains(event.target)) closeMenu()
    }

    // The plugins "+ Add" offers after the last step: allowed there, and
    // ticked in the Plugins dialog.
    function offered() {
      return launch.addable(steps, env).filter((Plugin) => shown(Plugin))
    }

    function separator() {
      const line = el('div', 'context-menu-separator')
      line.setAttribute('role', 'separator')
      return line
    }

    function menuItems() {
      return Array.from(menu.querySelectorAll('button'))
    }

    // 261121_dialog-and-command-plugins R5: the built-in plugins, then the
    // user's command plugins, then "Plugins…", a separator between groups.
    function openMenu() {
      menu.replaceChildren()
      const all = offered()
      const groups = [all.filter((Plugin) => !Plugin.source), all.filter((Plugin) => Plugin.source)]
      for (const group of groups) {
        if (!group.length) continue
        if (menu.children.length) menu.append(separator())
        for (const Plugin of group) {
          const item = button({
            text: Plugin.title,
            icon: Plugin.icon,
            className: 'context-menu-item launch-add-item',
            onClick: () => addStep(Plugin.id)
          })
          item.setAttribute('role', 'menuitem')
          item.dataset.plugin = Plugin.id
          menu.append(item)
        }
      }
      if (onPlugins) {
        if (menu.children.length) menu.append(separator())
        const item = button({
          text: 'Plugins…',
          icon: 'fa-puzzle-piece',
          className: 'context-menu-item launch-add-item launch-add-plugins',
          onClick: () => {
            closeMenu()
            return onPlugins()
          }
        })
        item.setAttribute('role', 'menuitem')
        item.dataset.action = 'plugins'
        menu.append(item)
      }
      menu.hidden = !menu.children.length
      add.setAttribute('aria-expanded', String(!menu.hidden))
      if (!menu.hidden) {
        placeMenu()
        document.addEventListener('scroll', onScroll, true)
        menuItems()[0].focus({ preventScroll: true })
      }
    }

    function focusStep(index) {
      const row = rows.children[index]
      const field = row ? row.querySelector('input, select, textarea') : null
      if (field) field.focus()
    }

    function addStep(id) {
      const Plugin = launch.plugin(id)
      if (!Plugin || !offered().includes(Plugin)) return false
      steps.push(new Plugin())
      render()
      focusStep(steps.length - 1)
      return true
    }

    function removeStep(index) {
      if (!launch.canRemove(steps, index, env)) return false
      steps.splice(index, 1)
      render()
      add.focus()
      return true
    }

    add.addEventListener('click', () => {
      if (menu.hidden) openMenu()
      else closeMenu()
    })
    menu.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        // The dialog's own Escape would close the whole dialog.
        event.stopPropagation()
        closeMenu()
        add.focus()
        return
      }
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
      event.preventDefault()
      const items = menuItems()
      const at = items.indexOf(document.activeElement)
      const next = (at + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length
      items[next].focus()
    })
    root.addEventListener('focusout', (event) => {
      if (!menu.hidden && !footer.contains(event.relatedTarget)) closeMenu()
    })

    render()

    return {
      root,
      steps: () => [...steps],
      serialize: () => launch.serialize(steps),
      compile: () => launch.compile(steps, named()),
      // Shows the chain's first problem and puts the cursor on it; true when
      // there is none.
      check() {
        const problem = launch.firstError(steps, named())
        if (!problem) return true
        setError(problem.message)
        focusStep(problem.index)
        return false
      },
      // Host facts arrive after the dialog opened.
      setEnv(next) {
        env = next || {}
        refresh()
      },
      // The Plugins dialog changed what "+ Add" offers, or loaded plugins.
      refresh() {
        if (!menu.hidden) openMenu()
        refresh()
      },
      add: addStep,
      remove: removeStep,
      openMenu,
      closeMenu,
      // For the debug commands: the chain as the dialog shows it.
      state() {
        return {
          steps: steps.map((step, index) => ({
            plugin: step.constructor.id,
            title: step.label(),
            config: step.getConfig(),
            removable: launch.canRemove(steps, index, env)
          })),
          addable: offered().map((Plugin) => Plugin.id),
          menuOpen: !menu.hidden,
          menu: Array.from(menu.children).map((item) =>
            item.getAttribute('role') === 'separator' ? '-' : item.textContent.trim()
          ),
          error: error.hidden ? '' : error.textContent,
          launch: launch.compile(steps, named())
        }
      }
    }
  }

  window.zbtermCreateStepsEditor = createStepsEditor
})()

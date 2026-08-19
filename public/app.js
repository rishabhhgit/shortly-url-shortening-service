document.documentElement.classList.add('motion-ready')

const form = document.querySelector('#shorten-form')
const urlInput = document.querySelector('#url-input')
const aliasInput = document.querySelector('#alias-input')
const aliasToggle = document.querySelector('#alias-toggle')
const aliasField = document.querySelector('#alias-field')
const formMessage = document.querySelector('#form-message')
const result = document.querySelector('#result')
const resultLink = document.querySelector('#result-link')
const copyResult = document.querySelector('#copy-result')
const linksList = document.querySelector('#links-list')
const toast = document.querySelector('#toast')
const toastMessage = document.querySelector('#toast-message')
const submitButton = form.querySelector('button[type="submit"]')
const checkoutButton = document.querySelector('#checkout-button')
const paymentNote = document.querySelector('#payment-note')
const paymentDialog = document.querySelector('#payment-dialog')
const dialogClose = document.querySelector('#dialog-close')
const header = document.querySelector('#site-header')
const menuToggle = document.querySelector('#menu-toggle')
const headerNav = document.querySelector('#header-nav')
const searchInput = document.querySelector('#search-input')
const loadMoreBtn = document.querySelector('#load-more-btn')
const paginationInfo = document.querySelector('#pagination-info')

let paymentConfig
let razorpayScriptPromise
let toastTimer
let currentPage = 1
let currentSearch = ''
let isLoadingMore = false

document.querySelector('#domain-prefix').textContent = `${window.location.host}/`

/* Mobile Menu */
menuToggle.addEventListener('click', () => {
  const open = headerNav.classList.toggle('open')
  menuToggle.setAttribute('aria-expanded', String(open))
})

headerNav.querySelectorAll('a').forEach((link) => {
  link.addEventListener('click', () => {
    headerNav.classList.remove('open')
    menuToggle.setAttribute('aria-expanded', 'false')
  })
})

/* Header Scroll Effect */
let scrollThrottle
window.addEventListener('scroll', () => {
  cancelAnimationFrame(scrollThrottle)
  scrollThrottle = requestAnimationFrame(() => {
    header.classList.toggle('scrolled', window.scrollY > 20)
  })
}, { passive: true })

/* Alias Toggle */
aliasToggle.addEventListener('click', () => {
  const willOpen = aliasField.hidden
  aliasField.hidden = !willOpen
  aliasToggle.setAttribute('aria-expanded', String(willOpen))
  if (willOpen) {
    requestAnimationFrame(() => aliasInput.focus())
  }
})

/* Search Input */
let searchDebounce
if (searchInput) {
  searchInput.addEventListener('input', (event) => {
    clearTimeout(searchDebounce)
    searchDebounce = setTimeout(() => {
      currentSearch = event.target.value.trim()
      currentPage = 1
      loadAndRenderLinks(true)
    }, 300)
  })
}

/* Load More */
if (loadMoreBtn) {
  loadMoreBtn.addEventListener('click', () => {
    currentPage++
    isLoadingMore = true
    loadAndRenderLinks(false)
  })
}

/* Shorten Form */
form.addEventListener('submit', async (event) => {
  event.preventDefault()
  formMessage.textContent = ''
  formMessage.className = 'form-message'
  result.hidden = true

  const url = urlInput.value.trim()
  if (!url) {
    showError('Enter a URL to shorten.')
    urlInput.focus()
    return
  }

  setLoading(true)
  try {
    const body = { url, customAlias: aliasInput.value.trim() }
    const response = await fetch('/api/links', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const data = await response.json()
    if (!response.ok) throw new Error(data.error || 'Could not shorten this URL.')

    resultLink.href = data.shortUrl
    resultLink.textContent = data.shortUrl
    result.hidden = false
    result.style.animation = 'none'
    requestAnimationFrame(() => {
      result.style.animation = ''
    })
    aliasInput.value = ''
    currentPage = 1
    currentSearch = ''
    if (searchInput) searchInput.value = ''
    await loadAndRenderLinks(true)
    showToast('Link created successfully', 'check')
  } catch (error) {
    showError(error.message)
  } finally {
    setLoading(false)
  }
})

/* Copy Result */
copyResult.addEventListener('click', () => copyText(resultLink.href, copyResult))

/* Payment Checkout */
checkoutButton.addEventListener('click', startCheckout)

dialogClose.addEventListener('click', () => {
  paymentDialog.close()
  document.querySelector('#url-input').focus()
})

/* Links List Events (delegated) */
linksList.addEventListener('click', async (event) => {
  const copyButton = event.target.closest('[data-copy]')
  const deleteButton = event.target.closest('[data-delete]')

  if (copyButton) {
    await copyText(copyButton.dataset.copy, copyButton)
  }

  if (deleteButton) {
    const article = deleteButton.closest('.link-item')
    if (article) article.classList.add('removing')
    deleteButton.disabled = true
    try {
      const response = await fetch(`/api/links/${encodeURIComponent(deleteButton.dataset.delete)}`, { method: 'DELETE' })
      if (!response.ok) throw new Error('Could not delete that link.')
      await loadAndRenderLinks(true)
      showToast('Link deleted', 'delete')
    } catch (error) {
      showToast(error.message, 'error')
      if (article) article.classList.remove('removing')
      deleteButton.disabled = false
    }
  }
})

/* API Helpers */
async function fetchLinks(page = 1, search = '') {
  const params = new URLSearchParams({ page: String(page), limit: '50' })
  if (search) params.set('search', search)
  const response = await fetch(`/api/links?${params}`)
  if (!response.ok) throw new Error('Could not load your links.')
  return response.json()
}

async function loadAndRenderLinks(reset = false) {
  if (reset) {
    currentPage = 1
    linksList.replaceChildren()
    showSkeletons(3)
  }

  try {
    const data = await fetchLinks(currentPage, currentSearch)
    hideSkeletons()
    renderLinks(data.links, reset)
    updatePagination(data.pagination)
  } catch (error) {
    hideSkeletons()
    showToast(error.message, 'error')
  }
}

/* Skeleton Loading */
function showSkeletons(count) {
  const existing = linksList.querySelectorAll('.skeleton-item')
  if (existing.length > 0) return

  for (let i = 0; i < count; i++) {
    const skeleton = document.createElement('div')
    skeleton.className = 'skeleton-item'
    skeleton.innerHTML = `
      <div class="skeleton-line skeleton-short"></div>
      <div class="skeleton-line skeleton-long"></div>
      <div class="skeleton-line skeleton-medium"></div>
    `
    linksList.append(skeleton)
  }
}

function hideSkeletons() {
  linksList.querySelectorAll('.skeleton-item').forEach((el) => el.remove())
}

/* Update Pagination */
function updatePagination(pagination) {
  if (!paginationInfo || !loadMoreBtn) return

  const { page, total, totalPages } = pagination
  paginationInfo.textContent = `Showing ${Math.min(page * 50, total)} of ${total} links`

  if (page < totalPages) {
    loadMoreBtn.hidden = false
    loadMoreBtn.disabled = false
    loadMoreBtn.textContent = 'Load more'
  } else {
    loadMoreBtn.hidden = true
  }
}

/* Render Links */
function renderLinks(links, reset = false) {
  if (reset) {
    linksList.replaceChildren()
  }

  if (links.length === 0 && !isLoadingMore) {
    const wrapper = document.createElement('div')
    wrapper.className = 'empty-state'
    wrapper.innerHTML = '<div class="empty-icon"><svg viewBox="0 0 24 24"><path d="M8.8 15.2 15.2 8.8M7.05 17.66l-1.41 1.41a3.5 3.5 0 0 1-4.95-4.95l3.54-3.54a3.5 3.5 0 0 1 4.95 0M16.95 6.34l1.41-1.41a3.5 3.5 0 0 1 4.95 4.95l-3.54 3.54a3.5 3.5 0 0 1-4.95 0" /></svg></div><h3>Your shortened links will appear here</h3><p>Paste a URL above to make your first one.</p>'
    linksList.append(wrapper)
    return
  }

  const startIndex = reset ? 0 : linksList.querySelectorAll('.link-item').length
  for (let i = 0; i < links.length; i++) {
    const link = links[i]
    const article = document.createElement('article')
    article.className = 'link-item'
    article.style.animationDelay = `${(startIndex + i) * 50}ms`

    const shortLink = document.createElement('a')
    shortLink.className = 'short-link'
    shortLink.href = link.shortUrl
    shortLink.target = '_blank'
    shortLink.rel = 'noopener noreferrer'
    shortLink.textContent = link.shortUrl.replace(/^https?:\/\//, '')

    const destination = document.createElement('span')
    destination.className = 'destination'
    destination.title = link.url
    destination.textContent = link.url

    const count = document.createElement('span')
    count.className = 'click-count'
    count.innerHTML = `<strong>${Number(link.clicks).toLocaleString()}</strong> ${link.clicks === 1 ? 'click' : 'clicks'}`

    const actions = document.createElement('div')
    actions.className = 'item-actions'
    actions.append(
      iconButton('Copy short link', 'copy', link.shortUrl),
      iconButton('Delete short link', 'delete', link.code),
    )

    article.append(shortLink, destination, count, actions)
    linksList.append(article)
  }
}

function iconButton(label, action, value) {
  const button = document.createElement('button')
  button.className = `icon-button${action === 'delete' ? ' danger' : ''}`
  button.type = 'button'
  button.title = label
  button.setAttribute('aria-label', label)
  button.dataset[action] = value
  button.innerHTML = action === 'copy'
    ? '<svg aria-hidden="true" viewBox="0 0 24 24"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>'
    : '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v5M14 11v5"/></svg>'
  return button
}

/* Copy to Clipboard */
async function copyText(text, button) {
  try {
    await navigator.clipboard.writeText(text)
    const label = button.querySelector('span')
    if (label) {
      const previous = label.textContent
      label.textContent = 'Copied!'
      button.classList.add('copied')
      window.setTimeout(() => {
        label.textContent = previous
        button.classList.remove('copied')
      }, 1400)
    }
    showToast('Copied to clipboard', 'check')
  } catch {
    showToast('Copy failed — select the link manually', 'error')
  }
}

/* Loading State */
function setLoading(isLoading) {
  submitButton.disabled = isLoading
  submitButton.classList.toggle('loading', isLoading)
}

/* Error Display */
function showError(message) {
  formMessage.textContent = message
}

/* Payment Config */
async function loadPaymentConfig() {
  try {
    const response = await fetch('/api/payments/config')
    if (!response.ok) throw new Error('Checkout configuration is unavailable.')
    paymentConfig = await response.json()

    const plan = paymentConfig.plans?.find((item) => item.id === checkoutButton.dataset.plan)
    if (plan) {
      const amount = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(plan.amount / 100)
      document.querySelector('.price').innerHTML = `<span>₹</span>${amount}`
    }

    if (paymentConfig.enabled) {
      checkoutButton.disabled = false
      paymentNote.textContent = 'UPI, cards, netbanking and wallets accepted'
    } else {
      paymentNote.textContent = 'Add Razorpay API keys to enable secure checkout'
    }
  } catch (error) {
    paymentNote.textContent = error.message
  }
}

/* Start Checkout */
async function startCheckout() {
  const buttonLabel = checkoutButton.querySelector('span')
  checkoutButton.disabled = true
  buttonLabel.textContent = 'Preparing checkout…'
  paymentNote.textContent = 'Creating a secure order…'

  try {
    await loadRazorpay()
    const response = await fetch('/api/payments/order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ planId: checkoutButton.dataset.plan }),
    })
    const order = await response.json()
    if (!response.ok) throw new Error(order.error || 'Could not start checkout.')

    let paymentVerified = false
    const checkout = new window.Razorpay({
      key: order.keyId,
      amount: order.amount,
      currency: order.currency,
      name: 'Shortly',
      description: order.description,
      order_id: order.orderId,
      theme: { color: '#ae7720', backdrop_color: '#332719' },
      modal: {
        ondismiss: () => {
          if (!paymentVerified) {
            checkoutButton.disabled = false
            buttonLabel.textContent = 'Get Golden Pro'
            paymentNote.textContent = 'UPI, cards, netbanking and wallets accepted'
          }
        },
      },
      handler: async (payment) => {
        buttonLabel.textContent = 'Verifying payment…'
        paymentNote.textContent = 'Securely confirming your payment…'
        try {
          const verifyResponse = await fetch('/api/payments/verify', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payment),
          })
          const verification = await verifyResponse.json()
          if (!verifyResponse.ok || !verification.verified) {
            throw new Error(verification.error || 'Payment verification failed.')
          }

          paymentVerified = true
          buttonLabel.textContent = 'Payment verified'
          paymentNote.textContent = 'Golden Pro payment complete'
          paymentDialog.showModal()
        } catch (error) {
          checkoutButton.disabled = false
          buttonLabel.textContent = 'Try payment again'
          paymentNote.textContent = error.message
          showToast(error.message, 'error')
        }
      },
    })

    checkout.on('payment.failed', (event) => {
      checkoutButton.disabled = false
      buttonLabel.textContent = 'Try payment again'
      paymentNote.textContent = event.error?.description || 'Payment was not completed.'
    })
    buttonLabel.textContent = 'Complete in checkout'
    paymentNote.textContent = 'Secure Razorpay checkout is open'
    checkout.open()
  } catch (error) {
    checkoutButton.disabled = false
    buttonLabel.textContent = 'Try payment again'
    paymentNote.textContent = error.message
    showToast(error.message, 'error')
  }
}

/* Load Razorpay SDK */
function loadRazorpay() {
  if (window.Razorpay) return Promise.resolve()
  if (razorpayScriptPromise) return razorpayScriptPromise

  razorpayScriptPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script')
    script.src = 'https://checkout.razorpay.com/v1/checkout.js'
    script.async = true
    script.onload = resolve
    script.onerror = () => reject(new Error('Could not load secure checkout. Check your connection.'))
    document.head.append(script)
  })
  return razorpayScriptPromise
}

/* Reveal Animations */
function setupRevealMotion() {
  const sections = document.querySelectorAll('.reveal')
  if (!('IntersectionObserver' in window)) {
    sections.forEach((section) => section.classList.add('visible'))
    return
  }

  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue
      entry.target.classList.add('visible')
      observer.unobserve(entry.target)
    }
  }, { threshold: 0.1, rootMargin: '0px 0px -40px 0px' })

  sections.forEach((section) => observer.observe(section))
}

/* Toast */
function showToast(message, type) {
  window.clearTimeout(toastTimer)

  const icon = toast.querySelector('svg')
  const paths = {
    check: 'm5 12 4 4L19 6',
    delete: 'M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6M10 11v5M14 11v5',
    error: 'M12 8v4m0 4h.01M22 12c0 5.523-4.477 10-10 10S2 17.523 2 12 6.477 2 12 2s10 4.477 10 10Z',
  }

  icon.setAttribute('viewBox', '0 0 24 24')
  icon.innerHTML = `<path d="${paths[type] || paths.check}" />`

  toastMessage.textContent = message
  toast.classList.add('visible')
  toastTimer = window.setTimeout(() => toast.classList.remove('visible'), 2400)
}

/* Keyboard Shortcuts */
document.addEventListener('keydown', (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key === 'k') {
    event.preventDefault()
    urlInput.focus()
    urlInput.select()
  }
})

/* Init */
loadAndRenderLinks(true)
loadPaymentConfig()
setupRevealMotion()

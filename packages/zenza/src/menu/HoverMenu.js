import {ZenzaWatch} from '../../../../src/ZenzaWatchIndex';
import {uq} from '../../../lib/src/uQuery';
import {nicoUtil} from '../../../lib/src/nico/nicoUtil';
import {cssUtil} from '../../../lib/src/css/css';
//===BEGIN===

// 公式の新UIでは動画カード全体 (data-anchor-href を持つ div) がクリックで遷移する
const VIDEO_LINK_SELECTOR = [
  'a[href*="watch/"]',
  'a[href*="shorts/"]',
  'a[href*="nico.ms/"]',
  '[data-anchor-href*="watch/"]',
  '[data-anchor-href*="shorts/"]',
  '.UadVideoItem-link'
].join(',');
// 動画カードの中にある投稿者リンクやボタンなどは横取りしない
const INTERACTIVE_SELECTOR = 'a[href],button,input,select,textarea,label,[role="button"],[role="menuitem"]';
const WATCH_HOSTS = ['www.nicovideo.jp', 'sp.nicovideo.jp', 'nico.ms'];

class HoverMenu {
  constructor(param) {
    this.initialize(param);
  }
  initialize(param) {
    this._playerConfig = param.playerConfig;

    const $view = this._$view = uq(
      '<zen-button class="ZenButton"><div class="ZenButtonInner scalingUI">Zen</div></zen-button>'
    );

    this._onHoverEnd = _.debounce(this._onHoverEnd.bind(this), 500);
    $view.on(
      location.host.includes('google') ? 'mouseup' : 'click', this._onClick.bind(this));
    ZenzaWatch.emitter.on('hideHover', () => $view.removeClass('show'));
    uq('body')
      .on('mouseover', this._onHover.bind(this))
      .on('mouseover', this._onHoverEnd)
      .on('mouseout', this._onMouseout.bind(this))
      .append($view);
    // 公式ページの React はルート要素のキャプチャ段階でクリックを処理するので、それより先に横取りする
    window.addEventListener('click', this._onLinkClick.bind(this), true);

    // ZenzaWatch 自身も開いている間は replaceState で URL を /watch/... に書き換えるので、
    // location ではなく公式のページ遷移 (SPAのpushと戻る/進む) だけを追って視聴ページかどうかを判定する
    this._isWatchPage = nicoUtil.isGinzaWatchUrl();
    window.navigation?.addEventListener('navigate', e => {
      if (['push', 'traverse'].includes(e.navigationType)) {
        this._isWatchPage = nicoUtil.isGinzaWatchUrl(e.destination.url);
      }
    });
  }
  get isOverrideWatchLink() {
    return !!this._playerConfig.props.overrideWatchLink &&
      location.host.endsWith('.nicovideo.jp') &&
      !this._isWatchPage;
  }
  setPlayer(player) {
    this._player = player;
    if (this._playerResolve) {
      this._playerResolve(player);
    }
  }
  _getPlayer() {
    if (this._player) {
      return Promise.resolve(this._player);
    }
    if (!this._playerPromise) {
      this._playerPromise = new Promise(resolve => {
        this._playerResolve = resolve;
      });
    }
    return this._playerPromise;
  }
  _findVideoLink(target) {
    if (!(target instanceof Element)) {
      return null;
    }
    const link = target.closest(VIDEO_LINK_SELECTOR);
    if (!link || link.classList.contains('noHoverMenu')) {
      return null;
    }
    const interactive = target.closest(INTERACTIVE_SELECTOR);
    if (interactive && interactive !== link && link.contains(interactive)) {
      return null;
    }
    return link;
  }
  _parseVideoLink(link) {
    const href = link.dataset.href || link.getAttribute('href') || link.dataset.anchorHref;
    if (!href) {
      return null;
    }
    let url;
    try {
      url = new URL(href, location.href);
    } catch (e) {
      return null;
    }
    if (!WATCH_HOSTS.includes(url.hostname)) {
      return null;
    }
    const watchId = nicoUtil.getWatchId(url.href);
    if (!watchId || !/^[a-z0-9]+$/.test(watchId) || watchId.startsWith('lv')) {
      return null;
    }
    return {watchId, query: nicoUtil.parseWatchQuery(url.search.substring(1))};
  }
  _onHover (e) {
    if (this.isOverrideWatchLink) {
      return;
    }
    const target = this._findVideoLink(e.target);
    if (target) {
      this._hoverElement = target;
    }
  }
  _onMouseout (e) {
    if (this._hoverElement === this._findVideoLink(e.target)) {
      this._hoverElement = null;
    }
  }
  _onHoverEnd (e) {
    if (!this._hoverElement || this.isOverrideWatchLink) { return; }
    const target = this._findVideoLink(e.target);
    if (!target || this._hoverElement !== target) {
      return;
    }
    const info = this._parseVideoLink(target);
    if (!info) {
      return;
    }
    this._query = info.query;
    this._watchId = info.watchId;

    const offset = target.getBoundingClientRect();
    this._$view.css({
      top: cssUtil.px(offset.top + window.pageYOffset),
      left: cssUtil.px(offset.left + window.pageXOffset)
    }).addClass('show');
    document.body.addEventListener('click', () => this._$view.removeClass('show'), {once: true});
  }
  _onClick (e) {
    const watchId = this._watchId;
    if (e.ctrlKey) {
      return;
    }

    if (e.shiftKey) {
      // 秘密機能。最後にZenzaWatchを開いたウィンドウで開く
      this._send(watchId);
    } else {
      this._open(watchId);
    }
  }
  open (watchId, params) {
    this._open(watchId, params);
  }
  async _open (watchId, params) {
    this._playerOption = Object.assign({
      economy: this._playerConfig.getValue('forceEconomy'),
      query: this._query,
      eventType: 'click'
    }, params);

    const player = await this._getPlayer();
    if (this._playerConfig.getValue('enableSingleton')) {
      ZenzaWatch.external.sendOrOpen(watchId, this._playerOption);
    } else {
      player.open(watchId, this._playerOption);
    }
  }
  send (watchId, params) {
    this._send(watchId, params);
  }
  async _send (watchId, params) {
    await this._getPlayer();
    ZenzaWatch.external.send(watchId, Object.assign({query: this._query}, params));
  }
  _onLinkClick (e) {
    if (e.button !== 0 || e.ctrlKey || e.metaKey || !this.isOverrideWatchLink) {
      return;
    }
    const target = this._findVideoLink(e.target);
    const info = target && this._parseVideoLink(target);
    if (!info) {
      return;
    }

    e.preventDefault();
    if (target.closest('.TimelineItem_video,.TimelineItem_shortVideo')) {
      // ニコレポは独自のクリック処理で遷移してしまうので止める
      e.stopPropagation();
    }

    this._query = info.query;
    if (e.shiftKey) {
      // 秘密機能。最後にZenzaWatchを開いたウィンドウで開く
      this._send(info.watchId);
    } else {
      this._open(info.watchId);
    }

    window.setTimeout(() => ZenzaWatch.emitter.emit('hideHover'), 1500);
  }
}

//===END===

export {HoverMenu};

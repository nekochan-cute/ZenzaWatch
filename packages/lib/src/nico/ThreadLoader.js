import {PopupMessage} from '../util';
import {sleep} from '../../packages/lib/src/infra/sleep';
import {netUtil} from '../../../lib/src/infra/netUtil';

const debug = {};

//===BEGIN===

const {ThreadLoader} = (() => {
  const FRONT_ID = '6';
  const FRONT_VER = '0';
  const CLIENT_OS_TYPE = 'others';
  const NVAPI_COMMENT_KEYS = 'https://nvapi.nicovideo.jp/v1/comment/keys';

  // 公式プレイヤーはキー取得とコメントサーバーへのリクエストに pc=1 を付けている
  const keyUrl = (type, params) => `${NVAPI_COMMENT_KEYS}/${type}?${new URLSearchParams({...params, pc: 1})}`;
  const commentServerUrl = (path, server) => {
    const url = new URL(path, server);
    url.searchParams.set('pc', '1');
    return url;
  };
  const COMMENT_SERVER_HEADERS = {
    'X-Frontend-Id': FRONT_ID,
    'X-Frontend-Version': FRONT_VER,
    'X-Client-Os-Type': CLIENT_OS_TYPE,
    'Content-Type': 'text/plain; charset=UTF-8'
  };

  // 公式と同じく、空白区切りで空のコマンドと重複を除く
  const parseCommands = cmd => [...new Set((cmd || '').split(/\s+/).filter(c => c))];

  // postKey の応答で challenge.isRequired が返ってきた時は Cloudflare Turnstile のトークンを添えないと投稿できない
  const TURNSTILE_URL = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
  const CHALLENGE_TIMEOUT_MS = 3 * 60 * 1000;
  let turnstileLoader = null;
  const loadTurnstile = () => {
    if (window.turnstile) {
      return Promise.resolve(window.turnstile);
    }
    if (!turnstileLoader) {
      turnstileLoader = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = TURNSTILE_URL;
        script.async = true;
        script.onload = () => window.turnstile ?
          resolve(window.turnstile) : reject(new Error('turnstile is not available'));
        script.onerror = () => reject(new Error('turnstile load error'));
        (document.head || document.documentElement).append(script);
      }).catch(err => {
        turnstileLoader = null;
        throw err;
      });
    }
    return turnstileLoader;
  };
  const solveChallenge = async siteKey => {
    const turnstile = await loadTurnstile();
    const container = document.createElement('div');
    container.className = 'zenzaTurnstileContainer';
    Object.assign(container.style, {
      position: 'fixed',
      top: '50%',
      left: '50%',
      transform: 'translate(-50%, -50%)',
      zIndex: '2147483647'
    });
    (document.fullscreenElement || document.body).append(container);
    let widgetId;
    try {
      return await new Promise((resolve, reject) => {
        const timer = window.setTimeout(() => reject(new Error('turnstile timeout')), CHALLENGE_TIMEOUT_MS);
        const settle = (fn, value) => {
          window.clearTimeout(timer);
          fn(value);
        };
        widgetId = turnstile.render(container, {
          sitekey: siteKey,
          size: 'normal',
          appearance: 'interaction-only',
          'before-interactive-callback': () =>
            PopupMessage.notify('コメント投稿の前に認証が必要です。画面中央の認証を完了してください'),
          callback: token => settle(resolve, token),
          'error-callback': code => settle(reject, new Error(`turnstile error ${code}`)),
          'timeout-callback': () => settle(reject, new Error('turnstile timeout')),
          'unsupported-callback': () => settle(reject, new Error('turnstile unsupported'))
        });
      });
    } finally {
      if (widgetId !== undefined) {
        turnstile.remove(widgetId);
      }
      container.remove();
    }
  };

  const FORK_LABEL = {
    0: 'main',
    1: 'owner',
    2: 'easy',
    3: 'ai',
  }

  class ThreadLoader {

    constructor() {
      this._threadKeys = {};
    }

    async getThreadKey(videoId, options = {}) {
      const url = keyUrl('thread', {videoId});

      console.log('getThreadKey url: ', url);
      try {
        const { meta, data } = await netUtil.fetch(url, {
          headers: {
            'X-Frontend-Id': FRONT_ID,
            'X-Frontend-Version': FRONT_VER,
          },
          credentials: 'include'
        }).then(res => res.json());
        if (meta.status >= 300) {
          throw meta
        }
        this._threadKeys[videoId] = data.threadKey;
        return data
      } catch (result) {
        throw { result, message: `ThreadKeyの取得失敗 ${videoId}` }
      }
    }

    async getPostKey(threadId, options = {}) {
      const url = keyUrl('post', {threadId});

      console.log('getPostKey url: ', url);
      try {
        const { meta, data } = await netUtil.fetch(url, {
          headers: {
            'X-Frontend-Id': FRONT_ID,
            'X-Frontend-Version': FRONT_VER,
          },
          credentials: 'include'
        }).then(res => res.json());
        if (meta.status >= 300) {
          throw meta
        }
        return data
      } catch (result) {
        throw { result, message: `PostKeyの取得失敗 ${threadId}` }
      }
    }

    async _delete(url, body, options = {}) {
      try {
        const { meta } = await netUtil.fetch(url, {
          method: 'PUT',
          headers: COMMENT_SERVER_HEADERS,
          body
        }).then(res => res.json());
        if (meta.status >= 300) {
          throw meta
        }
      } catch (result) {
        throw {
          result,
          message: `コメントの通信失敗`
        }
      }
    }

    async _post(url, body, options = {}) {
      try {
        const { meta, data } = await netUtil.fetch(url, {
          method: 'POST',
          headers: COMMENT_SERVER_HEADERS,
          body
        }).then(res => res.json());
        if (meta.status >= 300) {
          throw meta
        }
        return data;
      } catch (result) {
        throw {
          result,
          message: `コメントの通信失敗`
        }
      }
    }

    async _load(msgInfo, options = {}) {
      const {
        params,
        server,
        threadKey
      } = msgInfo.nvComment;

      const packet = {
        additionals: {},
        params,
        threadKey
      };

      if (options.retrying) {
        const info = await this.getThreadKey(msgInfo.videoId, options);
        console.log('threadKey: ', msgInfo.videoId, info);
        packet.threadKey = info.threadKey;
      }

      if (msgInfo.language !== params.language) {
        packet.params.language = msgInfo.language;
      }

      if (msgInfo.when > 0) {
        packet.additionals.when = msgInfo.when;
      }

      const url = commentServerUrl('/v1/threads', server);
      console.log('load threads...', url, packet);
      try {
        const { meta, data } = await netUtil.fetch(url, {
          method: 'POST',
          headers: COMMENT_SERVER_HEADERS,
          body: JSON.stringify(packet)
        }).then(res => res.json());
        if (meta.status >= 300) {
          throw meta;
        }
        return data;
      } catch (result) {
        throw {
          result,
          message: `コメントの通信失敗`
        }
      }
    }

    async load(msgInfo, options = {}) {
      const { videoId, userId } = msgInfo;

      const timeKey = `loadComment videoId: ${videoId}`;
      console.time(timeKey);

      let result;
      try {
        result = await this._load(msgInfo, options);
      } catch (e) {
        console.timeEnd(timeKey);
        window.console.error('loadComment fail 1st: ', e);
        PopupMessage.alert('コメントの取得失敗: 3秒後にリトライ');

        await sleep(3000);
        try {
          console.time(timeKey);
          result = await this._load(msgInfo, { retrying: true, ...options });
        } catch (e) {
          console.timeEnd(timeKey);
          window.console.error('loadComment fail finally: ', e);
          throw {
            message: 'コメントサーバーの通信失敗'
          }
        }
      }

      console.timeEnd(timeKey);
      debug.lastMessageServerResult = result;

      let totalResCount = result.globalComments.reduce((count, current) => (count + current.count), 0);
      for (const thread of result.threads) {
        const fork = thread.fork;
        thread.info = msgInfo.threads.find(({id, forkLabel}) => `${id}` === thread.id && forkLabel === fork);
        // 投稿者コメントはGlobalにカウントされていない
        if (fork === 'easy') {
          // かんたんコメントをカウントしていない挙動に合わせる。不要？
          const resCount = thread.commentCount;
          totalResCount -= resCount;
        }
      }

      const threadInfo = {
        userId,
        videoId,
        threadId: msgInfo.threadId,
        is184Forced: msgInfo.defaultThread.is184Forced,
        totalResCount,
        language: msgInfo.language,
        when: msgInfo.when,
        isWaybackMode: !!msgInfo.when
      };

      msgInfo.threadInfo = threadInfo;

      console.log('threadInfo: ', threadInfo);
      return {threadInfo, body: result, format: 'threads'};
    }

    async postChat(msgInfo, text, cmd, vpos, retrying = false) {
      const {
        videoId,
        threadId,
        language
      } = msgInfo.threadInfo;
      const url = commentServerUrl(`/v1/threads/${threadId}/comments`, msgInfo.nvComment.server);
      const { postKey, challenge } = await this.getPostKey(threadId, { language });
      let challengeToken;
      if (challenge?.isRequired && challenge.siteKey) {
        challengeToken = await solveChallenge(challenge.siteKey).catch(err => {
          window.console.error('challenge fail', err);
          throw {
            status: 'fail',
            message: 'コメント投稿失敗 (認証に失敗しました)'
          };
        });
      }

      const packet = JSON.stringify({
        body: text,
        commands: parseCommands(cmd),
        vposMs: Math.max(0, Math.floor((vpos || 0) * 10)),
        postKey,
        videoId,
        challengeToken,
      });
      console.log('post packet: ', packet);
      try {
        const { no, id } = await this._post(url, packet);
        return {
          status: 'ok',
          no,
          id,
          message: 'コメント投稿成功'
        };
      } catch (error) {
        const { status: statusCode, errorCode } = error.result ?? {};
        if (!retrying && ['INVALID_TOKEN', 'EXPIRED_TOKEN'].includes(errorCode)) {
          // postKey を取り直して1回だけ再送する
          return await this.postChat(msgInfo, text, cmd, vpos, true);
        }
        throw {
          status: 'fail',
          statusCode,
          message: errorCode ? `コメント投稿失敗 ${errorCode}` : 'コメント投稿失敗'
        };
      }
    }

    async getDeleteKey(threadId, options = {}) {
      const url = keyUrl('delete', {threadId, fork: options.fork || 'main'});

      console.log('getNicoruKey url: ', url);
      try {
        const { meta, data } = await netUtil.fetch(url, {
          headers: {
            'X-Frontend-Id': FRONT_ID,
            'X-Frontend-Version': FRONT_VER,
            'X-Niconico-Language': options.language || 'ja-jp'
          },
          credentials: 'include'
        }).then(res => res.json());
        if (meta.status >= 300) {
          throw meta
        }
        return data
      } catch (result) {
        throw { result, message: `DeleteKeyの取得失敗 ${threadId}` }
      }
    }

    async deleteChat(msgInfo, chat) {
      const {
        videoId,
        threadId,
        language
      } = msgInfo.threadInfo;
      const url = commentServerUrl(`/v1/threads/${threadId}/comment-comment-owner-deletions`, msgInfo.nvComment.server);
      const fork = FORK_LABEL[chat.fork || 0];
      const { deleteKey } = await this.getDeleteKey(threadId, { language, fork });
      const packet = JSON.stringify({
        deleteKey,
        fork,
        language,
        targets: [{
          no: chat.no,
          operation: 'DELETE'
        }],
        videoId,
      });
      console.log('put packet: ', packet);
      try {
        await this._delete(url, packet);
        return {
          status: 'ok',
          message: 'コメント削除成功'
        };
      } catch (error) {
        const { result: { status: statusCode, errorCode } } = error;
        throw {
          status: 'fail',
          statusCode,
          message: errorCode ? `コメント削除失敗 ${errorCode}` : 'コメント削除失敗'
        };
      }
    }

    async getNicoruKey(threadId, options = {}) {
      const url = keyUrl('nicoru', {threadId, fork: options.fork || 'main'});

      console.log('getNicoruKey url: ', url);
      try {
        const { meta, data } = await netUtil.fetch(url, {
          headers: {
            'X-Frontend-Id': FRONT_ID,
            'X-Frontend-Version': FRONT_VER,
            'X-Niconico-Language': options.language || 'ja-jp'
          },
          credentials: 'include'
        }).then(res => res.json());
        if (meta.status >= 300) {
          throw meta
        }
        return data
      } catch (result) {
        throw { result, message: `NicoruKeyの取得失敗 ${threadId}` }
      }
    }

    async nicoru(msgInfo, chat) {
      const {
        videoId,
        threadId,
        language
      } = msgInfo.threadInfo;
      const url = commentServerUrl(`/v1/threads/${threadId}/nicorus`, msgInfo.nvComment.server);
      const fork = FORK_LABEL[chat.fork || 0];
      const { nicoruKey } = await this.getNicoruKey(threadId, { language, fork });
      const packet = JSON.stringify({
        content: chat.text,
        fork,
        no: chat.no,
        nicoruKey,
        videoId,
      });
      console.log('post packet: ', packet);
      try {
        const { nicoruId, nicoruCount } = await this._post(url, packet);
        return {
          status: 'ok',
          id: nicoruId,
          count: nicoruCount,
          message: 'ニコれた'
        };
      } catch (error) {
        const { result: { status: statusCode, errorCode } } = error;
        throw {
          status: 'fail',
          statusCode,
          message: errorCode ? `ニコれなかった＞＜ ${errorCode}` : 'ニコれなかった＞＜'
        };
      }
    }
  }

  return {ThreadLoader: new ThreadLoader};
})();




//===END===

export {ThreadLoader};

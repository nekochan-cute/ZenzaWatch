import {netUtil} from '../infra/netUtil';

//===BEGIN===
const DEFAULT_LIMIT = 15;

/**
 * ニコニ・コモンズのコンテンツツリーを取得する。
 * _limit は親・子それぞれに掛かるので、最大で _limit * 2 件返ってくる。
 */
const CommonsTreeLoader = {
  load: (videoId, {limit = DEFAULT_LIMIT} = {}) => {
    const query = new URLSearchParams({
      _limit: `${limit}`,
      with_meta: '1',
      _sort: '-id',
    });
    const url = `https://public-api.commons.nicovideo.jp/v1/tree/${encodeURIComponent(videoId)}/relatives?${query.toString()}`;
    return netUtil.fetch(url, {credentials: 'omit'})
      .then(res => res.json())
      .then(json => {
        const {parents, children} = json?.data ?? {};
        return {
          parents: {
            total: parents?.total ?? 0,
            contents: parents?.contents ?? [],
          },
          children: {
            total: children?.total ?? 0,
            contents: children?.contents ?? [],
          },
        };
      });
  }
};

//===END===

export {CommonsTreeLoader};

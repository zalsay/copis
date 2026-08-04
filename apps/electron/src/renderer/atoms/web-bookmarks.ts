import { atom } from 'jotai'
import type { WebBookmark, WebBookmarkGroup } from '@copis/shared'

/** 主进程持久化的网页收藏列表。 */
export const webBookmarksAtom = atom<WebBookmark[]>([])

/** 主进程持久化的网页收藏分组。 */
export const webBookmarkGroupsAtom = atom<WebBookmarkGroup[]>([])

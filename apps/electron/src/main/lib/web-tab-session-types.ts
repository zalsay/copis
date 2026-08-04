/** 网页页签恢复状态的本地持久化类型。 */

export interface PersistedWebTab {
  url: string
}

export interface PersistedWebTabs {
  tabs: PersistedWebTab[]
  activeTabIndex: number | null
}

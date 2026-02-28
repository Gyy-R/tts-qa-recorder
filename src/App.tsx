import { useCallback, useEffect, useMemo, useState } from 'react'
import './App.css'
import {
  categoryLabels,
  feelingOptions,
  feelingOtherOption,
  textIssueTags,
  ttsIssueTags,
} from './constants'
import { isSupabaseConfigured, supabase } from './supabaseClient'
import type {
  IssueCategory,
  Observation,
  ObservationDraft,
  Session,
  SessionInput,
} from './types'

type PageTab = 'collect' | 'results' | 'analysis'
type CategoryFilter = 'all' | IssueCategory
type CourseFilter = 'all' | string
type ReporterFilter = 'all' | string
type TagFilter = 'all' | string
type AnalysisWindow = '7d' | '30d' | 'all'

interface ClassificationResult {
  category: IssueCategory
  reason: string
}

interface ProfileDraft {
  tester_device: string
  tester_os: string
}

const STORAGE_KEYS = {
  sessions: 'tts_collect_sessions_v2',
  observations: 'tts_collect_observations_v2',
  baseInfoCollapsed: 'tts_collect_base_info_collapsed_v2',
}

const textKeywords = [
  '夸奖',
  '夸麻木',
  '反馈',
  '策略',
  '口语',
  '不自然',
  '表达',
  '过头',
]

const ttsKeywords = [
  '发音',
  '断句',
  '停顿',
  '重读',
  '连读',
  '吞音',
  '语速',
  '噪声',
  '毛刺',
  '读音',
]

const textTagSet = new Set<string>(textIssueTags)
const ttsTagSet = new Set<string>(ttsIssueTags)

const emptySessionInput: SessionInput = {
  reporter_name: '',
  tester_device: '',
  tester_os: '',
}

const emptyObservationDraft: ObservationDraft = {
  course_name: '',
  tags: [],
  issue_description: '',
  feeling_tags: [],
  feeling_other: '',
}

function getMatchScore(text: string, keywords: string[]) {
  return keywords.reduce((sum, keyword) => {
    if (text.includes(keyword)) {
      return sum + 1
    }
    return sum
  }, 0)
}

function inferCategory(draft: ObservationDraft): ClassificationResult {
  const textTagScore = draft.tags.filter((tag) => textTagSet.has(tag)).length
  const ttsTagScore = draft.tags.filter((tag) => ttsTagSet.has(tag)).length

  const mergedText = [draft.issue_description, draft.tags.join(' ')].join(' ').toLowerCase()
  const textKeywordScore = getMatchScore(mergedText, textKeywords)
  const ttsKeywordScore = getMatchScore(mergedText, ttsKeywords)

  const textScore = textTagScore * 2 + textKeywordScore
  const ttsScore = ttsTagScore * 2 + ttsKeywordScore

  if (textScore > ttsScore) {
    return {
      category: 'text',
      reason: `文本得分 ${textScore}（标签 ${textTagScore}，关键词 ${textKeywordScore}）`,
    }
  }
  if (ttsScore > textScore) {
    return {
      category: 'tts',
      reason: `TTS得分 ${ttsScore}（标签 ${ttsTagScore}，关键词 ${ttsKeywordScore}）`,
    }
  }
  if (textTagScore > 0) {
    return { category: 'text', reason: '标签分数接近，默认归类为文本问题' }
  }
  return { category: 'tts', reason: '无明显线索，默认归类为TTS问题' }
}

function makeId() {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID()
  }
  return `${Date.now()}_${Math.random().toString(16).slice(2)}`
}

function readLocalStorage<T>(key: string): T[] {
  const raw = localStorage.getItem(key)
  if (!raw) {
    return []
  }
  try {
    const parsed = JSON.parse(raw) as T[]
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function writeLocalStorage<T>(key: string, value: T[]) {
  localStorage.setItem(key, JSON.stringify(value))
}

function escapeCsv(value: string) {
  return `"${value.replaceAll('"', '""')}"`
}

function normalizeText(value: string) {
  return value.trim().toLowerCase()
}

function getDateKey(date: Date) {
  return date.toISOString().slice(0, 10)
}

function formatPercent(value: number) {
  return `${(value * 100).toFixed(1)}%`
}

function App() {
  const [pageTab, setPageTab] = useState<PageTab>('collect')
  const [categoryFilter, setCategoryFilter] = useState<CategoryFilter>('all')
  const [courseFilter, setCourseFilter] = useState<CourseFilter>('all')
  const [reporterFilter, setReporterFilter] = useState<ReporterFilter>('all')
  const [tagFilter, setTagFilter] = useState<TagFilter>('all')
  const [analysisWindow, setAnalysisWindow] = useState<AnalysisWindow>('7d')
  const [keywordFilter, setKeywordFilter] = useState('')
  const [startDateFilter, setStartDateFilter] = useState('')
  const [endDateFilter, setEndDateFilter] = useState('')
  const [sessions, setSessions] = useState<Session[]>([])
  const [observations, setObservations] = useState<Observation[]>([])
  const [activeSessionId, setActiveSessionId] = useState('')
  const [sessionInput, setSessionInput] = useState<SessionInput>(emptySessionInput)
  const [observationDraft, setObservationDraft] =
    useState<ObservationDraft>(emptyObservationDraft)
  const [profileDrafts, setProfileDrafts] = useState<Record<string, ProfileDraft>>({})
  const [isBaseInfoCollapsed, setIsBaseInfoCollapsed] = useState(() => {
    return localStorage.getItem(STORAGE_KEYS.baseInfoCollapsed) === '1'
  })
  const [loading, setLoading] = useState(false)
  const [errorMessage, setErrorMessage] = useState('')
  const [successMessage, setSuccessMessage] = useState('')
  const [summaryCopied, setSummaryCopied] = useState(false)

  const sessionMap = useMemo(
    () => new Map(sessions.map((session) => [session.id, session])),
    [sessions],
  )
  const classification = useMemo(
    () => inferCategory(observationDraft),
    [observationDraft],
  )

  const currentReporterProfiles = useMemo(() => {
    const reporter = normalizeText(sessionInput.reporter_name)
    if (!reporter) {
      return []
    }
    return sessions.filter(
      (item) => normalizeText(item.reporter_name) === reporter,
    )
  }, [sessions, sessionInput.reporter_name])

  useEffect(() => {
    if (currentReporterProfiles.length === 0) {
      setActiveSessionId('')
      return
    }
    const hasActive = currentReporterProfiles.some((item) => item.id === activeSessionId)
    if (!hasActive) {
      setActiveSessionId(currentReporterProfiles[0].id)
    }
  }, [activeSessionId, currentReporterProfiles])

  const stats = useMemo(() => {
    const total = observations.length
    const textCount = observations.filter((item) => item.category === 'text').length
    const ttsCount = observations.filter((item) => item.category === 'tts').length
    return { total, textCount, ttsCount }
  }, [observations])

  const courseOptions = useMemo(() => {
    return [...new Set(observations.map((item) => item.course_name).filter(Boolean))]
  }, [observations])

  const reporterOptions = useMemo(() => {
    const reporters = observations
      .map((item) => sessionMap.get(item.session_id)?.reporter_name ?? '')
      .filter(Boolean)
    return [...new Set(reporters)]
  }, [observations, sessionMap])

  const tagOptions = useMemo(() => {
    const allTags = observations.flatMap((item) => item.tags)
    return [...new Set(allTags)]
  }, [observations])

  const observationCountBySession = useMemo(() => {
    const counts: Record<string, number> = {}
    observations.forEach((item) => {
      counts[item.session_id] = (counts[item.session_id] ?? 0) + 1
    })
    return counts
  }, [observations])

  const filteredObservations = useMemo(() => {
    return observations.filter((item) => {
      const passCategory =
        categoryFilter === 'all' ? true : item.category === categoryFilter
      const passCourse = courseFilter === 'all' ? true : item.course_name === courseFilter
      const reporterName = sessionMap.get(item.session_id)?.reporter_name ?? ''
      const passReporter =
        reporterFilter === 'all' ? true : reporterName === reporterFilter
      const passTag = tagFilter === 'all' ? true : item.tags.includes(tagFilter)
      const keyword = keywordFilter.trim().toLowerCase()
      const mergedText =
        `${item.course_name} ${item.issue_description} ${item.tags.join(' ')} ${(item.feeling_tags ?? []).join(' ')} ${item.feeling_other ?? ''}`.toLowerCase()
      const passKeyword = keyword ? mergedText.includes(keyword) : true
      const day = item.created_at.slice(0, 10)
      const passStart = startDateFilter ? day >= startDateFilter : true
      const passEnd = endDateFilter ? day <= endDateFilter : true
      return (
        passCategory &&
        passCourse &&
        passReporter &&
        passTag &&
        passKeyword &&
        passStart &&
        passEnd
      )
    })
  }, [
    categoryFilter,
    courseFilter,
    reporterFilter,
    tagFilter,
    keywordFilter,
    startDateFilter,
    endDateFilter,
    observations,
    sessionMap,
  ])

  const analysisData = useMemo(() => {
    const now = new Date()
    now.setHours(23, 59, 59, 999)

    const windowDays =
      analysisWindow === '7d' ? 7 : analysisWindow === '30d' ? 30 : null

    let currentStart: Date | null = null
    let previousStart: Date | null = null
    let previousEnd: Date | null = null

    if (windowDays) {
      currentStart = new Date(now)
      currentStart.setHours(0, 0, 0, 0)
      currentStart.setDate(currentStart.getDate() - (windowDays - 1))

      previousEnd = new Date(currentStart.getTime() - 1)
      previousStart = new Date(previousEnd)
      previousStart.setHours(0, 0, 0, 0)
      previousStart.setDate(previousStart.getDate() - (windowDays - 1))
    }

    const currentItems = observations.filter((item) => {
      if (!currentStart) {
        return true
      }
      const created = new Date(item.created_at)
      return created >= currentStart && created <= now
    })

    const previousItems =
      previousStart && previousEnd
        ? observations.filter((item) => {
            const created = new Date(item.created_at)
            return created >= previousStart && created <= previousEnd
          })
        : []

    const textCount = currentItems.filter((item) => item.category === 'text').length
    const ttsCount = currentItems.filter((item) => item.category === 'tts').length
    const totalCount = currentItems.length

    const tagCountMap: Record<string, number> = {}
    currentItems.forEach((item) => {
      item.tags.forEach((tag) => {
        tagCountMap[tag] = (tagCountMap[tag] ?? 0) + 1
      })
    })
    const topTags = Object.entries(tagCountMap)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)

    const courseCountMap: Record<string, number> = {}
    currentItems.forEach((item) => {
      courseCountMap[item.course_name] = (courseCountMap[item.course_name] ?? 0) + 1
    })
    const topCourses = Object.entries(courseCountMap)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)

    const feelingCountMap: Record<string, number> = {}
    currentItems.forEach((item) => {
      ;(item.feeling_tags ?? []).forEach((feeling) => {
        feelingCountMap[feeling] = (feelingCountMap[feeling] ?? 0) + 1
      })
    })
    const topFeelings = Object.entries(feelingCountMap)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)

    const trendDays = windowDays ?? 14
    const trendStart = new Date(now)
    trendStart.setHours(0, 0, 0, 0)
    trendStart.setDate(trendStart.getDate() - (trendDays - 1))

    const trendCountMap: Record<string, number> = {}
    for (let idx = 0; idx < trendDays; idx += 1) {
      const day = new Date(trendStart)
      day.setDate(trendStart.getDate() + idx)
      trendCountMap[getDateKey(day)] = 0
    }
    const trendSource =
      windowDays === null
        ? currentItems.filter((item) => new Date(item.created_at) >= trendStart)
        : currentItems
    trendSource.forEach((item) => {
      const key = getDateKey(new Date(item.created_at))
      if (key in trendCountMap) {
        trendCountMap[key] += 1
      }
    })
    const dailyTrend = Object.entries(trendCountMap)

    return {
      windowDays,
      currentItems,
      previousItems,
      totalCount,
      textCount,
      ttsCount,
      topTags,
      topCourses,
      topFeelings,
      dailyTrend,
    }
  }, [analysisWindow, observations])

  const summaryText = useMemo(() => {
    const periodLabel =
      analysisWindow === '7d'
        ? '最近7天'
        : analysisWindow === '30d'
          ? '最近30天'
          : '全量数据'
    const ratioText =
      analysisData.totalCount > 0
        ? `文本占比 ${formatPercent(analysisData.textCount / analysisData.totalCount)}，TTS占比 ${formatPercent(analysisData.ttsCount / analysisData.totalCount)}`
        : '当前没有数据'

    const compareText =
      analysisData.windowDays && analysisData.previousItems.length > 0
        ? (() => {
            const diff =
              ((analysisData.totalCount - analysisData.previousItems.length) /
                analysisData.previousItems.length) *
              100
            const direction = diff >= 0 ? '上升' : '下降'
            return `相较上一周期（${analysisData.previousItems.length}条）${direction} ${Math.abs(diff).toFixed(1)}%`
          })()
        : '暂无可比对的上一周期数据'

    const topTagText =
      analysisData.topTags.length > 0
        ? analysisData.topTags
            .map(([tag, count], idx) => `${idx + 1}. ${tag}（${count}）`)
            .join('；')
        : '无'

    const topCourseText =
      analysisData.topCourses.length > 0
        ? analysisData.topCourses
            .map(([course, count], idx) => `${idx + 1}. ${course}（${count}）`)
            .join('；')
        : '无'

    const topFeelingText =
      analysisData.topFeelings.length > 0
        ? analysisData.topFeelings
            .map(([feeling, count], idx) => `${idx + 1}. ${feeling}（${count}）`)
            .join('；')
        : '无'

    const samples = analysisData.currentItems.slice(0, 3).map((item, idx) => {
      const reporter = sessionMap.get(item.session_id)?.reporter_name ?? '未知'
      return `${idx + 1}) [${item.course_name}] ${item.issue_description}（${reporter}）`
    })

    return [
      `【TTS问题周报】${periodLabel}`,
      `- 共记录 ${analysisData.totalCount} 条问题，${ratioText}。`,
      `- 趋势：${compareText}。`,
      `- 高频标签：${topTagText}。`,
      `- 高频课程：${topCourseText}。`,
      `- 主观感受分布：${topFeelingText}。`,
      `- 典型样例：${samples.length > 0 ? samples.join('；') : '无'}。`,
    ].join('\n')
  }, [analysisData, analysisWindow, sessionMap])

  const maxTrendCount = useMemo(() => {
    const values = analysisData.dailyTrend.map(([, count]) => count)
    return Math.max(1, ...values)
  }, [analysisData.dailyTrend])

  const loadInitialData = useCallback(async (silent = false) => {
    if (!silent) {
      setLoading(true)
      setErrorMessage('')
    }
    try {
      if (!supabase) {
        const localSessions = readLocalStorage<Session>(STORAGE_KEYS.sessions)
        const localObservations = readLocalStorage<Observation>(STORAGE_KEYS.observations)
        setSessions(localSessions)
        setObservations(localObservations)
        return
      }

      const [sessionsRes, observationsRes] = await Promise.all([
        supabase
          .from('sessions')
          .select('*')
          .order('created_at', { ascending: false })
          .limit(200),
        supabase
          .from('observations')
          .select('*')
          .order('created_at', { ascending: false })
          .limit(5000),
      ])

      if (sessionsRes.error) {
        throw sessionsRes.error
      }
      if (observationsRes.error) {
        throw observationsRes.error
      }

      setSessions((sessionsRes.data ?? []) as Session[])
      setObservations((observationsRes.data ?? []) as Observation[])
    } catch (error) {
      if (!silent) {
        setErrorMessage(
          error instanceof Error ? error.message : '加载数据失败，请检查配置。',
        )
      }
    } finally {
      if (!silent) {
        setLoading(false)
      }
    }
  }, [])

  useEffect(() => {
    void loadInitialData()
  }, [loadInitialData])

  useEffect(() => {
    if (!supabase) {
      return
    }
    const timerId = setInterval(() => {
      void loadInitialData(true)
    }, 15000)
    return () => clearInterval(timerId)
  }, [loadInitialData])

  const handleCreateProfile = async () => {
    if (!sessionInput.reporter_name.trim() || !sessionInput.tester_device.trim()) {
      setErrorMessage('测试人/账号和设备必填。')
      return
    }

    setLoading(true)
    setErrorMessage('')
    setSuccessMessage('')
    try {
      if (!supabase) {
        const localSession: Session = {
          id: makeId(),
          reporter_name: sessionInput.reporter_name.trim(),
          tester_device: sessionInput.tester_device.trim(),
          tester_os: sessionInput.tester_os.trim() || null,
          created_at: new Date().toISOString(),
        }
        setSessions((prev) => {
          const next = [localSession, ...prev]
          writeLocalStorage(STORAGE_KEYS.sessions, next)
          return next
        })
        setActiveSessionId(localSession.id)
        setIsBaseInfoCollapsed(true)
        localStorage.setItem(STORAGE_KEYS.baseInfoCollapsed, '1')
        setSuccessMessage('设备档案已保存（本地模式）。')
        return
      }

      const payload = {
        reporter_name: sessionInput.reporter_name.trim(),
        tester_device: sessionInput.tester_device.trim(),
        tester_os: sessionInput.tester_os.trim() || null,
      }
      const { data, error } = await supabase
        .from('sessions')
        .insert(payload)
        .select('*')
        .single()
      if (error) {
        throw error
      }
      const created = data as Session
      setSessions((prev) => [created, ...prev])
      setActiveSessionId(created.id)
      setIsBaseInfoCollapsed(true)
      localStorage.setItem(STORAGE_KEYS.baseInfoCollapsed, '1')
      setSuccessMessage('设备档案已保存。')
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '设备档案保存失败。')
    } finally {
      setLoading(false)
    }
  }

  const handleSelectProfile = (sessionId: string) => {
    setActiveSessionId(sessionId)
    const profile = sessions.find((item) => item.id === sessionId)
    if (!profile) {
      return
    }
    setSessionInput((prev) => ({
      ...prev,
      reporter_name: profile.reporter_name,
      tester_device: profile.tester_device ?? '',
      tester_os: profile.tester_os ?? '',
    }))
  }

  const getProfileDraft = (profile: Session): ProfileDraft => {
    return (
      profileDrafts[profile.id] ?? {
        tester_device: profile.tester_device ?? '',
        tester_os: profile.tester_os ?? '',
      }
    )
  }

  const setProfileDraftField = (
    profile: Session,
    key: keyof ProfileDraft,
    value: string,
  ) => {
    setProfileDrafts((prev) => ({
      ...prev,
      [profile.id]: {
        ...(prev[profile.id] ?? {
          tester_device: profile.tester_device ?? '',
          tester_os: profile.tester_os ?? '',
        }),
        [key]: value,
      },
    }))
  }

  const handleSaveProfileChanges = async (profile: Session) => {
    const draft = getProfileDraft(profile)
    if (!draft.tester_device.trim()) {
      setErrorMessage('设备名称不能为空。')
      return
    }

    setLoading(true)
    setErrorMessage('')
    setSuccessMessage('')
    try {
      const updates = {
        tester_device: draft.tester_device.trim(),
        tester_os: draft.tester_os.trim() || null,
      }

      if (!supabase) {
        setSessions((prev) => {
          const next = prev.map((item) =>
            item.id === profile.id ? { ...item, ...updates } : item,
          )
          writeLocalStorage(STORAGE_KEYS.sessions, next)
          return next
        })
      } else {
        const { data, error } = await supabase
          .from('sessions')
          .update(updates)
          .eq('id', profile.id)
          .select('*')
          .single()
        if (error) {
          throw error
        }
        const updated = data as Session
        setSessions((prev) =>
          prev.map((item) => (item.id === updated.id ? updated : item)),
        )
      }

      if (activeSessionId === profile.id) {
        setSessionInput((prev) => ({
          ...prev,
          tester_device: updates.tester_device,
          tester_os: updates.tester_os ?? '',
        }))
      }
      setSuccessMessage('设备档案已更新。')
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '设备档案更新失败。')
    } finally {
      setLoading(false)
    }
  }

  const handleDeleteProfile = async (profile: Session) => {
    const relatedCount = observationCountBySession[profile.id] ?? 0
    const confirmText =
      relatedCount > 0
        ? `确定删除该设备档案吗？会同时删除该设备下 ${relatedCount} 条问题记录。`
        : '确定删除该设备档案吗？'
    if (!window.confirm(confirmText)) {
      return
    }

    setLoading(true)
    setErrorMessage('')
    setSuccessMessage('')
    try {
      const fallbackProfile =
        currentReporterProfiles.find((item) => item.id !== profile.id) ?? null

      if (!supabase) {
        setSessions((prev) => {
          const next = prev.filter((item) => item.id !== profile.id)
          writeLocalStorage(STORAGE_KEYS.sessions, next)
          return next
        })
        setObservations((prev) => {
          const next = prev.filter((item) => item.session_id !== profile.id)
          writeLocalStorage(STORAGE_KEYS.observations, next)
          return next
        })
      } else {
        const { error } = await supabase.from('sessions').delete().eq('id', profile.id)
        if (error) {
          throw error
        }
        setSessions((prev) => prev.filter((item) => item.id !== profile.id))
        setObservations((prev) => prev.filter((item) => item.session_id !== profile.id))
      }

      setProfileDrafts((prev) => {
        const next = { ...prev }
        delete next[profile.id]
        return next
      })

      if (activeSessionId === profile.id) {
        setActiveSessionId(fallbackProfile?.id ?? '')
        if (fallbackProfile) {
          setSessionInput((prev) => ({
            ...prev,
            reporter_name: fallbackProfile.reporter_name,
            tester_device: fallbackProfile.tester_device ?? '',
            tester_os: fallbackProfile.tester_os ?? '',
          }))
        } else {
          setSessionInput((prev) => ({ ...prev, tester_device: '', tester_os: '' }))
        }
      }
      setSuccessMessage('设备档案已删除。')
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '设备档案删除失败。')
    } finally {
      setLoading(false)
    }
  }

  const toggleTag = (tag: string) => {
    setObservationDraft((prev) => {
      const exists = prev.tags.includes(tag)
      return {
        ...prev,
        tags: exists ? prev.tags.filter((item) => item !== tag) : [...prev.tags, tag],
      }
    })
  }

  const toggleFeeling = (feeling: string) => {
    setObservationDraft((prev) => {
      const exists = prev.feeling_tags.includes(feeling)
      const nextFeelingTags = exists
        ? prev.feeling_tags.filter((item) => item !== feeling)
        : [...prev.feeling_tags, feeling]
      return {
        ...prev,
        feeling_tags: nextFeelingTags,
        feeling_other: nextFeelingTags.includes(feelingOtherOption) ? prev.feeling_other : '',
      }
    })
  }

  const handleSubmitIssue = async () => {
    if (!activeSessionId) {
      setErrorMessage('请先选择或创建一个设备档案。')
      return
    }
    if (!observationDraft.course_name.trim()) {
      setErrorMessage('请填写课程名。')
      return
    }
    if (!observationDraft.issue_description.trim()) {
      setErrorMessage('请填写问题描述。')
      return
    }
    if (observationDraft.tags.length === 0) {
      setErrorMessage('请至少选择一个标签（文本或TTS任意一个都可以）。')
      return
    }
    if (observationDraft.feeling_tags.length === 0) {
      setErrorMessage('请至少选择一个主观感受。')
      return
    }
    if (
      observationDraft.feeling_tags.includes(feelingOtherOption) &&
      !observationDraft.feeling_other.trim()
    ) {
      setErrorMessage('选择“其他”时请填写具体主观感受。')
      return
    }

    const autoCategory = inferCategory(observationDraft).category
    setLoading(true)
    setErrorMessage('')
    setSuccessMessage('')
    try {
      if (!supabase) {
        const localObservation: Observation = {
          id: makeId(),
          session_id: activeSessionId,
          course_name: observationDraft.course_name.trim(),
          category: autoCategory,
          tags: observationDraft.tags,
          issue_description: observationDraft.issue_description.trim(),
          feeling_tags: observationDraft.feeling_tags,
          feeling_other: observationDraft.feeling_other.trim() || null,
          created_at: new Date().toISOString(),
        }
        setObservations((prev) => {
          const next = [localObservation, ...prev]
          writeLocalStorage(STORAGE_KEYS.observations, next)
          return next
        })
        setSuccessMessage(
          `问题已提交（本地模式），自动分类为：${categoryLabels[autoCategory]}`,
        )
        setObservationDraft((prev) => ({
          ...prev,
          tags: [],
          issue_description: '',
          feeling_tags: [],
          feeling_other: '',
        }))
        setPageTab('results')
        return
      }

      const payload = {
        session_id: activeSessionId,
        course_name: observationDraft.course_name.trim(),
        category: autoCategory,
        tags: observationDraft.tags,
        issue_description: observationDraft.issue_description.trim(),
        feeling_tags: observationDraft.feeling_tags,
        feeling_other: observationDraft.feeling_other.trim() || null,
      }
      const { data, error } = await supabase
        .from('observations')
        .insert(payload)
        .select('*')
        .single()
      if (error) {
        throw error
      }
      setObservations((prev) => [data as Observation, ...prev])
      setSuccessMessage(`问题已提交，自动分类为：${categoryLabels[autoCategory]}`)
      setObservationDraft((prev) => ({
        ...prev,
        tags: [],
        issue_description: '',
        feeling_tags: [],
        feeling_other: '',
      }))
      setPageTab('results')
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '问题提交失败。')
    } finally {
      setLoading(false)
    }
  }

  const toggleBaseInfo = () => {
    setIsBaseInfoCollapsed((prev) => {
      const next = !prev
      localStorage.setItem(STORAGE_KEYS.baseInfoCollapsed, next ? '1' : '0')
      return next
    })
  }

  const exportCsv = () => {
    if (filteredObservations.length === 0) {
      return
    }
    const header = [
      '时间',
      '课程名',
      '测试人/账号',
      '设备',
      '系统',
      '分类',
      '标签',
      '问题描述',
      '主观感受',
      '主观感受-其他',
    ]
    const rows = filteredObservations.map((item) => {
      const session = sessionMap.get(item.session_id)
      return [
        item.created_at,
        item.course_name,
        session?.reporter_name ?? '',
        session?.tester_device ?? '',
        session?.tester_os ?? '',
        categoryLabels[item.category],
        item.tags.join(' | '),
        item.issue_description,
        (item.feeling_tags ?? []).join(' | '),
        item.feeling_other ?? '',
      ]
    })
    const csv = [header, ...rows]
      .map((row) => row.map((cell) => escapeCsv(String(cell))).join(','))
      .join('\n')
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `tts-collect-${new Date().toISOString().slice(0, 10)}.csv`
    link.click()
    URL.revokeObjectURL(url)
  }

  const handleCopySummary = async () => {
    try {
      await navigator.clipboard.writeText(summaryText)
      setSummaryCopied(true)
      setTimeout(() => setSummaryCopied(false), 2000)
    } catch {
      setErrorMessage('复制总结失败，请手动复制。')
    }
  }

  return (
    <main className="app">
      <header className="panel">
        <h1>TTS测试记录平台</h1>
        <p className="subtitle">设备档案按人管理，课程名独立填写</p>
        <div className="tab-switcher">
          <button
            type="button"
            className={pageTab === 'collect' ? 'tab-button active' : 'tab-button'}
            onClick={() => setPageTab('collect')}
          >
            📝 收集页面
          </button>
          <button
            type="button"
            className={pageTab === 'results' ? 'tab-button active' : 'tab-button'}
            onClick={() => setPageTab('results')}
          >
            📊 收集结果
          </button>
          <button
            type="button"
            className={pageTab === 'analysis' ? 'tab-button active' : 'tab-button'}
            onClick={() => setPageTab('analysis')}
          >
            ✨ 分析总结
          </button>
        </div>
        {!isSupabaseConfigured && (
          <p className="warning">
            当前未配置 Supabase，已启用本地模式（仅当前浏览器可见）。
          </p>
        )}
        {errorMessage && <p className="error">{errorMessage}</p>}
        {successMessage && <p className="success">{successMessage}</p>}
      </header>

      {pageTab === 'collect' ? (
        <>
          <section className="panel">
            <div className="section-title-row">
              <h2>👤 基础信息（个人设备档案）</h2>
              <button type="button" className="plain-toggle" onClick={toggleBaseInfo}>
                {isBaseInfoCollapsed ? '展开' : '折叠'}
              </button>
            </div>
            {!isBaseInfoCollapsed ? (
              <>
                <div className="field-grid">
                  <label>
                    测试人/账号*
                    <input
                      value={sessionInput.reporter_name}
                      onChange={(event) =>
                        setSessionInput((prev) => ({
                          ...prev,
                          reporter_name: event.target.value,
                        }))
                      }
                      placeholder="例如：alice001"
                    />
                  </label>
                  <label>
                    设备*
                    <input
                      value={sessionInput.tester_device}
                      onChange={(event) =>
                        setSessionInput((prev) => ({
                          ...prev,
                          tester_device: event.target.value,
                        }))
                      }
                      placeholder="例如：iPhone 15 Pro"
                    />
                  </label>
                  <label>
                    系统
                    <input
                      value={sessionInput.tester_os}
                      onChange={(event) =>
                        setSessionInput((prev) => ({
                          ...prev,
                          tester_os: event.target.value,
                        }))
                      }
                      placeholder="例如：iOS 18.3 / HarmonyOS 4"
                    />
                  </label>
                </div>
                <div className="actions">
                  <button type="button" onClick={handleCreateProfile} disabled={loading}>
                    保存为设备档案
                  </button>
                  <select
                    value={activeSessionId}
                    onChange={(event) => handleSelectProfile(event.target.value)}
                  >
                    <option value="">选择已有设备档案（当前测试人）</option>
                    {currentReporterProfiles.map((profile) => (
                      <option key={profile.id} value={profile.id}>
                        {(profile.tester_device ?? '未命名设备') +
                          ' / ' +
                          (profile.tester_os ?? '未知系统')}
                      </option>
                    ))}
                  </select>
                </div>

                {sessionInput.reporter_name.trim() && (
                  <div className="profile-list">
                    <p className="hint">
                      当前测试人已有设备档案：{currentReporterProfiles.length}
                    </p>
                    {currentReporterProfiles.length === 0 ? (
                      <p className="hint">还没有设备档案，先保存一条。</p>
                    ) : (
                      currentReporterProfiles.map((profile) => {
                        const draft = getProfileDraft(profile)
                        return (
                          <article key={profile.id} className="profile-card">
                            <div className="profile-grid">
                              <label>
                                设备
                                <input
                                  value={draft.tester_device}
                                  onChange={(event) =>
                                    setProfileDraftField(
                                      profile,
                                      'tester_device',
                                      event.target.value,
                                    )
                                  }
                                />
                              </label>
                              <label>
                                系统
                                <input
                                  value={draft.tester_os}
                                  onChange={(event) =>
                                    setProfileDraftField(
                                      profile,
                                      'tester_os',
                                      event.target.value,
                                    )
                                  }
                                />
                              </label>
                            </div>
                            <p className="compact">
                              关联问题数：{observationCountBySession[profile.id] ?? 0}
                            </p>
                            <div className="actions">
                              <button
                                type="button"
                                className="secondary"
                                onClick={() => handleSelectProfile(profile.id)}
                                disabled={loading}
                              >
                                使用该档案
                              </button>
                              <button
                                type="button"
                                className="secondary"
                                onClick={() => void handleSaveProfileChanges(profile)}
                                disabled={loading}
                              >
                                保存修改
                              </button>
                              <button
                                type="button"
                                className="danger"
                                onClick={() => void handleDeleteProfile(profile)}
                                disabled={loading}
                              >
                                删除档案
                              </button>
                            </div>
                          </article>
                        )
                      })
                    )}
                  </div>
                )}
              </>
            ) : (
              <p className="hint">
                当前档案：
                {sessionMap.get(activeSessionId)?.reporter_name ?? '未选择测试人'} /{' '}
                {sessionMap.get(activeSessionId)?.tester_device ?? '未选择设备'} /{' '}
                {sessionMap.get(activeSessionId)?.tester_os ?? '未填写系统'}
              </p>
            )}
          </section>

          <section className="panel">
            <h2>🧩 问题收集</h2>
            <div className="field-grid">
              <label>
                课程名*
                <input
                  value={observationDraft.course_name}
                  onChange={(event) =>
                    setObservationDraft((prev) => ({
                      ...prev,
                      course_name: event.target.value,
                    }))
                  }
                  placeholder="例如：英语口语课第5节"
                />
              </label>
              <label className="full-width">
                问题描述*
                <textarea
                  value={observationDraft.issue_description}
                  onChange={(event) =>
                    setObservationDraft((prev) => ({
                      ...prev,
                      issue_description: event.target.value,
                    }))
                  }
                  placeholder="小白刚说太棒啦，你一下就答对了，真是个数学天才。夸的太过头了"
                />
              </label>
              <p className="hint">
                自动分类结果：{categoryLabels[classification.category]}（{classification.reason}）
              </p>
            </div>

            <div className="tag-group">
              <strong>文本标签（含策略问题）</strong>
              <div className="tag-list">
                {textIssueTags.map((tag) => (
                  <button
                    key={tag}
                    type="button"
                    className={observationDraft.tags.includes(tag) ? 'tag active' : 'tag'}
                    onClick={() => toggleTag(tag)}
                  >
                    {tag}
                  </button>
                ))}
              </div>
            </div>

            <div className="tag-group">
              <strong>TTS标签</strong>
              <div className="tag-list">
                {ttsIssueTags.map((tag) => (
                  <button
                    key={tag}
                    type="button"
                    className={observationDraft.tags.includes(tag) ? 'tag active' : 'tag'}
                    onClick={() => toggleTag(tag)}
                  >
                    {tag}
                  </button>
                ))}
              </div>
            </div>

            <div className="tag-group">
              <strong>主观感受（多选）*</strong>
              <div className="tag-list">
                {feelingOptions.map((option) => (
                  <button
                    key={option}
                    type="button"
                    className={
                      observationDraft.feeling_tags.includes(option) ? 'tag active' : 'tag'
                    }
                    onClick={() => toggleFeeling(option)}
                  >
                    {option}
                  </button>
                ))}
              </div>
              {observationDraft.feeling_tags.includes(feelingOtherOption) && (
                <label className="full-width">
                  其他主观感受
                  <textarea
                    className="other-feeling-box"
                    rows={6}
                    value={observationDraft.feeling_other}
                    onChange={(event) =>
                      setObservationDraft((prev) => ({
                        ...prev,
                        feeling_other: event.target.value,
                      }))
                    }
                  />
                </label>
              )}
            </div>

            <div className="actions">
              <button
                type="button"
                className="submit-button"
                onClick={handleSubmitIssue}
                disabled={loading}
              >
                提交问题
              </button>
            </div>
          </section>
        </>
      ) : pageTab === 'results' ? (
        <>
          <section className="panel">
            <h2>📌 收集结果概览</h2>
            <div className="stats">
              <div className="stat-item">
                <span>总问题数</span>
                <strong>{stats.total}</strong>
              </div>
              <div className="stat-item">
                <span>文本问题</span>
                <strong>{stats.textCount}</strong>
              </div>
              <div className="stat-item">
                <span>TTS问题</span>
                <strong>{stats.ttsCount}</strong>
              </div>
            </div>
            <div className="actions">
              <button type="button" className="secondary" onClick={() => void loadInitialData()}>
                手动刷新
              </button>
              <button
                type="button"
                className="secondary"
                onClick={exportCsv}
                disabled={filteredObservations.length === 0}
              >
                导出CSV
              </button>
              <select
                value={courseFilter}
                onChange={(event) => setCourseFilter(event.target.value as CourseFilter)}
              >
                <option value="all">全部课程</option>
                {courseOptions.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
              <select
                value={reporterFilter}
                onChange={(event) => setReporterFilter(event.target.value as ReporterFilter)}
              >
                <option value="all">全部测试人</option>
                {reporterOptions.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
              <select
                value={categoryFilter}
                onChange={(event) => setCategoryFilter(event.target.value as CategoryFilter)}
              >
                <option value="all">全部分类</option>
                <option value="text">文本问题</option>
                <option value="tts">TTS问题</option>
              </select>
              <select
                value={tagFilter}
                onChange={(event) => setTagFilter(event.target.value as TagFilter)}
              >
                <option value="all">全部标签</option>
                {tagOptions.map((tag) => (
                  <option key={tag} value={tag}>
                    {tag}
                  </option>
                ))}
              </select>
              <input
                className="filter-input"
                placeholder="关键词搜索（课程/描述/标签/主观感受）"
                value={keywordFilter}
                onChange={(event) => setKeywordFilter(event.target.value)}
              />
              <input
                className="filter-input"
                type="date"
                value={startDateFilter}
                onChange={(event) => setStartDateFilter(event.target.value)}
              />
              <input
                className="filter-input"
                type="date"
                value={endDateFilter}
                onChange={(event) => setEndDateFilter(event.target.value)}
              />
            </div>
          </section>

          <section className="panel">
            <h2>📋 收集列表</h2>
            {filteredObservations.length === 0 && <p className="hint">暂无记录。</p>}
            <div className="list">
              {filteredObservations.map((item) => {
                const session = sessionMap.get(item.session_id)
                return (
                  <article key={item.id} className="list-item">
                    <div className="list-header">
                      <strong>{categoryLabels[item.category]}</strong>
                      <span>{new Date(item.created_at).toLocaleString()}</span>
                    </div>
                    <p className="compact">
                      课程：<span className="course-pill">{item.course_name}</span> ｜ 测试人/账号：
                      {session?.reporter_name ?? '-'}
                    </p>
                    <p className="compact">
                      设备：{session?.tester_device ?? '-'} ｜ 系统：{session?.tester_os ?? '-'}
                    </p>
                    <p className="compact">问题描述：{item.issue_description}</p>
                    <p className="compact">
                      标签：{item.tags.length > 0 ? item.tags.join('、') : '无'}
                    </p>
                    <p className="compact">
                      主观感受：
                      {item.feeling_tags && item.feeling_tags.length > 0
                        ? item.feeling_tags.join('、')
                        : '无'}
                      {item.feeling_other ? `（其他：${item.feeling_other}）` : ''}
                    </p>
                  </article>
                )
              })}
            </div>
          </section>
        </>
      ) : (
        <>
          <section className="panel">
            <h2>📈 分析窗口</h2>
            <div className="actions">
              <select
                value={analysisWindow}
                onChange={(event) => setAnalysisWindow(event.target.value as AnalysisWindow)}
              >
                <option value="7d">最近7天</option>
                <option value="30d">最近30天</option>
                <option value="all">全量数据</option>
              </select>
              <button type="button" className="secondary" onClick={() => setPageTab('results')}>
                查看明细列表
              </button>
            </div>
            <div className="stats">
              <div className="stat-item">
                <span>窗口问题数</span>
                <strong>{analysisData.totalCount}</strong>
              </div>
              <div className="stat-item">
                <span>文本占比</span>
                <strong>
                  {analysisData.totalCount > 0
                    ? formatPercent(analysisData.textCount / analysisData.totalCount)
                    : '-'}
                </strong>
              </div>
              <div className="stat-item">
                <span>TTS占比</span>
                <strong>
                  {analysisData.totalCount > 0
                    ? formatPercent(analysisData.ttsCount / analysisData.totalCount)
                    : '-'}
                </strong>
              </div>
            </div>
            <p className="hint">
              {analysisData.windowDays && analysisData.previousItems.length > 0
                ? `上一周期记录 ${analysisData.previousItems.length} 条，本周期 ${
                    analysisData.totalCount >= analysisData.previousItems.length
                      ? '上升'
                      : '下降'
                  } ${Math.abs(
                    ((analysisData.totalCount - analysisData.previousItems.length) /
                      analysisData.previousItems.length) *
                      100,
                  ).toFixed(1)}%。`
                : '暂无可比较的上一周期数据。'}
            </p>
          </section>

          <section className="panel">
            <h2>🧭 问题分布</h2>
            <div className="analysis-grid">
              <article className="analysis-card">
                <h3>高频标签 TOP5</h3>
                {analysisData.topTags.length === 0 ? (
                  <p className="hint">暂无数据</p>
                ) : (
                  <div className="rank-list">
                    {analysisData.topTags.map(([tag, count], index) => (
                      <p key={tag} className="compact">
                        {index + 1}. {tag}（{count}）
                      </p>
                    ))}
                  </div>
                )}
              </article>
              <article className="analysis-card">
                <h3>高频课程 TOP5</h3>
                {analysisData.topCourses.length === 0 ? (
                  <p className="hint">暂无数据</p>
                ) : (
                  <div className="rank-list">
                    {analysisData.topCourses.map(([course, count], index) => (
                      <p key={course} className="compact">
                        {index + 1}. {course}（{count}）
                      </p>
                    ))}
                  </div>
                )}
              </article>
              <article className="analysis-card">
                <h3>主观感受 TOP5</h3>
                {analysisData.topFeelings.length === 0 ? (
                  <p className="hint">暂无数据</p>
                ) : (
                  <div className="rank-list">
                    {analysisData.topFeelings.map(([feeling, count], index) => (
                      <p key={feeling} className="compact">
                        {index + 1}. {feeling}（{count}）
                      </p>
                    ))}
                  </div>
                )}
              </article>
            </div>
          </section>

          <section className="panel">
            <h2>📅 每日趋势</h2>
            {analysisData.dailyTrend.length === 0 ? (
              <p className="hint">暂无趋势数据</p>
            ) : (
              <div className="trend-list">
                {analysisData.dailyTrend.map(([date, count]) => (
                  <div key={date} className="trend-row">
                    <span className="trend-date">{date.slice(5)}</span>
                    <div className="trend-bar-wrap">
                      <div
                        className="trend-bar"
                        style={{ width: `${Math.max(8, (count / maxTrendCount) * 100)}%` }}
                      />
                    </div>
                    <span className="trend-value">{count}</span>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="panel">
            <h2>🪄 一键总结</h2>
            <div className="actions">
              <button type="button" className="secondary" onClick={() => void handleCopySummary()}>
                复制总结文案
              </button>
              {summaryCopied && <span className="success">已复制</span>}
            </div>
            <textarea className="summary-box" readOnly value={summaryText} />
          </section>
        </>
      )}

      {loading && (
        <div className="loading-mask">
          <span>处理中...</span>
        </div>
      )}
    </main>
  )
}

export default App

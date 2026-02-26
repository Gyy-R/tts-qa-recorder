export type IssueCategory = 'text' | 'tts'

export interface Session {
  id: string
  reporter_name: string
  tester_device: string | null
  tester_os: string | null
  created_at: string
}

export interface Observation {
  id: string
  session_id: string
  course_name: string
  category: IssueCategory
  tags: string[]
  issue_description: string
  feeling_tags: string[]
  feeling_other: string | null
  created_at: string
}

export interface SessionInput {
  reporter_name: string
  tester_device: string
  tester_os: string
}

export interface ObservationDraft {
  course_name: string
  tags: string[]
  issue_description: string
  feeling_tags: string[]
  feeling_other: string
}

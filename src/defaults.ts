export const DEFAULT_TOOL_NAME = 'tool_search'

/** Deferred-loading activates only at or above this many deferrable tools. */
export const DEFAULT_THRESHOLD = 15

/** Default number of full definitions returned by one search. */
export const DEFAULT_MAX_RESULTS = 5

export const DEFAULT_REQUIRE_DISCOVERY = true
export const DEFAULT_CHARACTERS_PER_TOKEN = 4
/** Per-tool description cap in the resident catalog section, in characters. */
export const DEFAULT_DESCRIPTION_CHARS = 110
export const DEFAULT_DEFER_TOOL_GUIDANCE = true

/** Hot-path tools (deferrable: never) keep their full schemas on every request. */
export const DEFAULT_ALWAYS_VISIBLE: readonly string[] = [
  'skill',
  'ask_user_question',
  'report',
  'submit_*',
  'structured_output*',
]

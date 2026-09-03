export interface DiffLine {
  kind: 'same' | 'add' | 'del'
  text: string
}

/**
 * LCS-based line diff of two strings, split on '\n'. Emits common lines as
 * 'same', lines only in a as 'del', lines only in b as 'add', in order.
 *
 * ponytail: O(lenA·lenB) DP; strategies are capped and diffs render in one
 * drawer — ceiling a few thousand lines; upgrade path Myers/patience only if
 * it ever hurts.
 */
export function lineDiff(a: string, b: string): DiffLine[] {
  // '' would split to [''] and render a phantom line — treat it as zero lines.
  const A = a === '' ? [] : a.split('\n')
  const B = b === '' ? [] : b.split('\n')
  const n = A.length
  const m = B.length
  // dp[i][j] = LCS length of A[i..] and B[j..].
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] = A[i] === B[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!)
    }
  }
  const out: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (A[i] === B[j]) {
      out.push({ kind: 'same', text: A[i]! })
      i++
      j++
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      // Tie-breaks toward 'del' so a modified line renders as old-then-new.
      out.push({ kind: 'del', text: A[i]! })
      i++
    } else {
      out.push({ kind: 'add', text: B[j]! })
      j++
    }
  }
  while (i < n) {
    out.push({ kind: 'del', text: A[i]! })
    i++
  }
  while (j < m) {
    out.push({ kind: 'add', text: B[j]! })
    j++
  }
  return out
}
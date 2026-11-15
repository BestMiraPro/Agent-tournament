import { useEffect, useState } from 'react'
import { getRoundOutput, getRoundOutputFile, serverError, type RoundStats, type TeamFile, type TeamOutput as TeamOutputData } from '../api.js'
import { fileContributors, formatBytes, sealLine } from '../lib/team.js'
import { Markdown } from './Markdown.js'

/** The files of one round's sealed output, with who wrote each, as a pickable list. */
export function TeamFileList({ output, selected, onSelect }: {
  output: TeamOutputData
  selected: string | null
  onSelect: (path: string) => void
}) {
  const by = fileContributors(output)
  if (output.files.length === 0) return <p className="muted">The output folder was empty.</p>
  return (
    <ul className="teamoutput__files">
      {output.files.map((f) => (
        <li key={f.path}>
          <button className={f.path === selected ? 'teamoutput__file teamoutput__file--on' : 'teamoutput__file'} onClick={() => onSelect(f.path)}>
            {f.path}
          </button>{' '}
          <span className="muted">{formatBytes(f.bytes)}{f.binary ? ' · binary' : ''}{by.get(f.path) ? ` · ${by.get(f.path)!.join(', ')}` : ''}</span>
        </li>
      ))}
    </ul>
  )
}

/** One file as captured: markdown rendered, other text verbatim, binary or unstored files described. */
export function TeamFileView({ file }: { file: TeamFile & { content: string | null } }) {
  if (file.content === null) {
    return <p className="muted">{file.binary ? 'Binary file: listed and hashed, not shown.' : 'Too large to store with the snapshot: listed and hashed only.'}</p>
  }
  return file.path.toLowerCase().endsWith('.md') ? <Markdown text={file.content} /> : <pre className="teamoutput__text">{file.content}</pre>
}

/**
 * Browses a collaboration round's sealed output folder: the files the team built, who wrote
 * them, and each file's captured content — what the grader was given, not the live folder.
 */
export function TeamOutput({ runId, rounds, refreshKey }: { runId: string; rounds: RoundStats[]; refreshKey: number }) {
  const teamRounds = rounds.filter((r) => r.team)
  const latest = teamRounds.at(-1)?.idx ?? null
  const [picked, setPicked] = useState<number | null>(null)
  const roundIdx = picked !== null && teamRounds.some((r) => r.idx === picked) ? picked : latest
  const [output, setOutput] = useState<TeamOutputData | null>(null)
  const [path, setPath] = useState<string | null>(null)
  const [file, setFile] = useState<(TeamFile & { content: string | null }) | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (roundIdx === null) return
    let alive = true
    setFile(null)
    getRoundOutput(runId, roundIdx).then(
      (o) => {
        if (!alive) return
        setOutput(o)
        setError(null)
        setPath(o.files.some((f) => f.path === 'output/README.md') ? 'output/README.md' : o.files[0]?.path ?? null)
      },
      (e) => { if (alive) { setOutput(null); setError(serverError(e)) } },
    )
    return () => { alive = false }
  }, [runId, roundIdx, refreshKey])

  useEffect(() => {
    if (roundIdx === null || path === null) return
    let alive = true
    getRoundOutputFile(runId, roundIdx, path).then(
      (f) => { if (alive) setFile(f) },
      (e) => { if (alive) setError(serverError(e)) },
    )
    return () => { alive = false }
  }, [runId, roundIdx, path])

  const score = teamRounds.find((r) => r.idx === roundIdx)?.team ?? null
  return (
    <section className="teamoutput" aria-labelledby="teamoutput-h">
      <h2 id="teamoutput-h">Team output</h2>
      {roundIdx === null ? (
        <p className="muted">No judged round yet: the sealed output of each round appears here.</p>
      ) : (
        <>
          <label htmlFor="teamoutput-round">Round</label>{' '}
          <select id="teamoutput-round" value={roundIdx} onChange={(e) => setPicked(Number(e.target.value))}>
            {teamRounds.map((r) => <option key={r.idx} value={r.idx}>round {r.idx} · team score {r.team!.score.toFixed(2)}</option>)}
          </select>
          {score && <p><strong>Team score: {score.score.toFixed(2)}</strong> <span className="badge">{score.status}</span></p>}
          {error && <p className="error">{error}</p>}
          {output && (
            <>
              <p className="muted">{sealLine(output)}</p>
              {output.errorText && <p className="error">{output.errorText}</p>}
              <div className="teamoutput__body">
                <TeamFileList output={output} selected={path} onSelect={setPath} />
                <div className="teamoutput__view">{file && <TeamFileView file={file} />}</div>
              </div>
            </>
          )}
        </>
      )}
    </section>
  )
}

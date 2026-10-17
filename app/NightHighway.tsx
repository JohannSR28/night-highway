'use client';

import { useEffect } from 'react';
import { startNightHighway } from './engine';

// Static markup for the game. The engine drives it imperatively by id after mount,
// so this component never re-renders.
export default function NightHighway() {
  useEffect(() => {
    startNightHighway();
  }, []);

  return (
    <>
      <canvas id="scene" tabIndex={0} aria-label="Night Highway driving game"></canvas>

      <div id="hud" className="layer" hidden>
        <div className="timebar" id="timebar"><i id="timefill"></i></div>
        <div className="stat"><span className="label">Time</span><span className="clock" id="clock">60.0</span></div>
        <div className="stat right">
          <span className="label">Score</span>
          <span className="score" id="score">0</span>
          <span className="sub"><span id="dist">0.00</span> km · <span id="nm">0</span> near misses</span>
        </div>
        <div className="hint" id="hint">
          W / ↑ gas · S / ↓ brake · A D / ← → steer<br />
          Shift or Space nitro · V camera · C paint · L glow · H hide HUD · P pause
        </div>
        <div className="speedo" id="speedo">
          <svg viewBox="0 0 250 140" aria-hidden="true">
            <g id="ticks"></g>
            <path className="arc-bg" d="M 25 125 A 100 100 0 0 1 225 125"></path>
            <path className="arc-fill" id="arc" d="M 25 125 A 100 100 0 0 1 225 125"></path>
          </svg>
          <div className="readout"><span className="speed" id="speed">0</span><span className="unit">km/h</span></div>
          <div className="speedo-foot">
            <span className="gear">Gear<b id="gear">1</b></span>
            <div className="nbar" aria-label="Nitro"><i id="nitro"></i></div>
          </div>
        </div>
      </div>

      <div id="pops" aria-live="polite"></div>
      <div id="count" aria-live="assertive"></div>

      <section id="title" className="layer screen" hidden>
        <div className="card">
          <p className="kicker">60 seconds · one road · after midnight</p>
          <h1 className="wordmark"><span>Night</span><span className="hot">Highway</span></h1>
          <p className="lede">Weave through late traffic, chain near misses for points, and see how far one minute takes you.</p>
          <div className="row">
            <button className="cta" id="startBtn" type="button">Drive <kbd>Enter</kbd></button>
            <span className="note" id="bestLine"></span>
          </div>
          <dl className="keys">
            <div><dt>W ↑</dt><dd>Gas</dd></div>
            <div><dt>S ↓</dt><dd>Brake</dd></div>
            <div><dt>A D ← →</dt><dd>Steer</dd></div>
            <div><dt>Shift</dt><dd>Nitro</dd></div>
            <div><dt>V</dt><dd>Camera</dd></div>
            <div><dt>C</dt><dd>Paint</dd></div>
            <div><dt>L</dt><dd>Light glow</dd></div>
            <div><dt>M</dt><dd>Sound</dd></div>
            <div><dt>H</dt><dd>Hide HUD</dd></div>
          </dl>
        </div>
      </section>

      <section id="results" className="layer screen" hidden>
        <div className="card">
          <p className="kicker" id="resKicker">Run complete</p>
          <p className="results-score" id="resScore">0</p>
          <p className="best" id="resBest"></p>
          <dl className="stats">
            <div><dt>Distance</dt><dd><span id="rDist">0</span><small>km</small></dd></div>
            <div><dt>Top speed</dt><dd><span id="rTop">0</span><small>km/h</small></dd></div>
            <div><dt>Average</dt><dd><span id="rAvg">0</span><small>km/h</small></dd></div>
            <div><dt>Near misses</dt><dd id="rNm">0</dd></div>
            <div><dt>Overtakes</dt><dd id="rOv">0</dd></div>
            <div><dt>Crashes</dt><dd id="rCr">0</dd></div>
          </dl>
          <div className="row"><button className="cta" id="againBtn" type="button">Drive again <kbd>Enter</kbd></button></div>
        </div>
      </section>

      <div id="pause" className="layer" hidden><p>Paused<small>P to resume · R to restart</small></p></div>

      <div id="touch" hidden>
        <div className="tgroup">
          <button className="tbtn" data-k="left" type="button" aria-label="Steer left">◀</button>
          <button className="tbtn" data-k="right" type="button" aria-label="Steer right">▶</button>
        </div>
        <div className="tgroup">
          <button className="tbtn" data-k="down" type="button">Brake</button>
          <button className="tbtn" data-k="boost" type="button">Nitro</button>
        </div>
      </div>

      <div id="boot" className="layer"><p>Warming up the engine…</p></div>
    </>
  );
}

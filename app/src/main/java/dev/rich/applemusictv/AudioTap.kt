package dev.rich.applemusictv

import android.media.audiofx.Visualizer
import android.os.Handler
import android.os.HandlerThread
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import kotlin.math.hypot
import kotlin.math.log10
import kotlin.math.max
import kotlin.math.pow

/**
 * Real audio analysis for the visualiser.
 *
 * The web player can't supply it: MusicKit's audio is Widevine-protected, and Chromium hands
 * Web Audio silence for protected media. Android's Visualizer effect on session 0 reads the
 * device's OUTPUT MIX instead — the same PCM the speakers get — so the bands are the music
 * itself. The platform gates that behind RECORD_AUDIO; nothing here opens the microphone.
 *
 * Polled rather than callback-driven: the capture listener tops out at ~20 Hz, while getFft()
 * returns the latest window on demand, so a 60 Hz poll gives the page fresh data every frame.
 * Frames go out as one compact line: "a <rms> <24 band dB values> | <64 waveform samples>".
 */
class AudioTap(private val emit: (String) -> Unit) {

    private var vis: Visualizer? = null
    private var thread: HandlerThread? = null
    private var worker: Handler? = null
    private val main = Handler(Looper.getMainLooper())
    @Volatile private var running = false

    private var fft = ByteArray(0)
    private var wave = ByteArray(0)
    private var edges = IntArray(0)
    private var frames = 0
    private var t0 = 0L

    /** Returns null on success, or why the tap couldn't start. */
    fun start(): String? {
        if (running) return null
        val v = try { Visualizer(0) } catch (e: Throwable) { return "Visualizer(0): ${e.message}" }
        try {
            v.enabled = false
            val size = Visualizer.getCaptureSizeRange()[1].coerceAtMost(1024)
            v.captureSize = size
            v.scalingMode = Visualizer.SCALING_MODE_NORMALIZED   // volume-independent shapes
            v.measurementMode = Visualizer.MEASUREMENT_MODE_PEAK_RMS
            fft = ByteArray(size); wave = ByteArray(size)
            edges = bandEdges(size, v.samplingRate / 1000f)
            if (v.setEnabled(true) != Visualizer.SUCCESS) { v.release(); return "Visualizer.setEnabled failed" }
        } catch (e: Throwable) { v.release(); return "Visualizer setup: ${e.message}" }
        vis = v
        running = true
        frames = 0; t0 = SystemClock.uptimeMillis()
        thread = HandlerThread("AudioTap").also { it.start(); worker = Handler(it.looper); worker!!.post(::tick) }
        Log.i(TAG, "audio tap on: capture ${fft.size}, ${v.samplingRate / 1000} Hz")
        return null
    }

    fun stop() {
        running = false
        thread?.quitSafely(); thread = null; worker = null
        vis?.let { try { it.enabled = false; it.release() } catch (_: Throwable) {} }
        vis = null
    }

    private val m = Visualizer.MeasurementPeakRms()

    private fun tick() {
        if (!running) return
        val v = vis ?: return
        val started = SystemClock.uptimeMillis()
        try {
            v.getFft(fft); v.getWaveForm(wave); v.getMeasurementPeakRms(m)
            val sb = StringBuilder(420)
            sb.append("a ").append(m.mRms)                       // mB; -9600 is silence
            // FFT bytes: [0]=Re(DC) [1]=Re(Nyquist) then (Re,Im) pairs for bins 1..n/2-1.
            for (b in 0 until BANDS) {
                var peak = 0.0
                for (k in edges[b] until max(edges[b] + 1, edges[b + 1])) {
                    val mag = hypot(fft[2 * k].toDouble(), fft[2 * k + 1].toDouble())
                    if (mag > peak) peak = mag
                }
                sb.append(' ').append(((20 * log10(peak + 1.0)) * 10).toInt() / 10.0)   // 0..~45 dB
            }
            sb.append(" |")
            // Trigger like an oscilloscope: start at the first rising zero-crossing in the first
            // half, so a steady tone draws in the same place every frame; then average down.
            val half = wave.size / 2
            var start = 0
            for (i in 1 until half) {
                if ((wave[i - 1].toInt() and 0xff) < 128 && (wave[i].toInt() and 0xff) >= 128) { start = i; break }
            }
            val step = half / WAVE
            for (i in 0 until WAVE) {
                var acc = 0
                for (j in 0 until step) acc += (wave[start + i * step + j].toInt() and 0xff) - 128
                sb.append(' ').append(acc / step)
            }
            val line = sb.toString()
            main.post { if (running) emit(line) }
            if (++frames == 600) {
                Log.i(TAG, "audio tap: ${600_000 / max(1, (SystemClock.uptimeMillis() - t0).toInt())} fps, rms ${m.mRms} mB")
                frames = 0; t0 = SystemClock.uptimeMillis()
            }
        } catch (e: Throwable) { Log.w(TAG, "audio tap: ${e.message}") }
        worker?.postAtTime(::tick, started + FRAME_MS)
    }

    companion object {
        private const val TAG = "AudioTap"
        const val BANDS = 24
        private const val WAVE = 64
        private const val FRAME_MS = 16L

        // Log-spaced band edges from 40 Hz to 16 kHz, as FFT bin indices. Low bands are narrower
        // than a bin at this capture size, so each band is at least one bin wide.
        private fun bandEdges(size: Int, rateHz: Float): IntArray {
            val binHz = rateHz / size
            val n = size / 2
            return IntArray(BANDS + 1) { i ->
                val hz = 40.0 * (16000.0 / 40.0).pow(i / BANDS.toDouble())
                (hz / binHz).toInt().coerceIn(1, n - 1)
            }.also { for (i in 1..BANDS) if (it[i] <= it[i - 1]) it[i] = (it[i - 1] + 1).coerceAtMost(n - 1) }
        }
    }
}

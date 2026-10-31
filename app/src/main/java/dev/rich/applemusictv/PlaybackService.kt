package dev.rich.applemusictv

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import android.support.v4.media.MediaMetadataCompat
import android.support.v4.media.session.MediaSessionCompat
import android.support.v4.media.session.PlaybackStateCompat
import androidx.core.app.NotificationCompat
import androidx.media.session.MediaButtonReceiver

/**
 * Foreground media service. It keeps the app process (and therefore the WebView's audio)
 * alive after the user leaves the app, and hosts a MediaSession so the TV's media controls
 * and the remote's transport keys route back into the web player even when backgrounded.
 *
 * The Activity owns the WebView; this service owns the notification + session. They talk
 * through two static hooks below (same process), so no binding is needed.
 */
class PlaybackService : android.app.Service() {

    override fun onBind(i: Intent?) = null

    override fun onCreate() {
        super.onCreate()
        ensureSession(this)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        ensureSession(this)
        // Media-button intents (from the notification actions / remote) reach the session callback here.
        MediaButtonReceiver.handleIntent(session, intent)
        val playing = intent?.getBooleanExtra(EXTRA_PLAYING, lastPlaying) ?: lastPlaying
        val title = intent?.getStringExtra(EXTRA_TITLE) ?: lastTitle
        val artist = intent?.getStringExtra(EXTRA_ARTIST) ?: lastArtist
        applyState(playing, title, artist)
        return START_STICKY
    }

    private fun applyState(playing: Boolean, title: String, artist: String) {
        // Rebuilding the notification and re-writing session state for identical data is pure
        // churn on the media stack; skip it.
        if (started && playing == lastPlaying && title == lastTitle && artist == lastArtist) return
        started = true
        lastPlaying = playing; lastTitle = title; lastArtist = artist
        val s = session ?: return
        s.isActive = true
        s.setMetadata(MediaMetadataCompat.Builder()
            .putString(MediaMetadataCompat.METADATA_KEY_TITLE, title)
            .putString(MediaMetadataCompat.METADATA_KEY_ARTIST, artist)
            .build())
        s.setPlaybackState(PlaybackStateCompat.Builder()
            .setActions(PlaybackStateCompat.ACTION_PLAY or PlaybackStateCompat.ACTION_PAUSE or
                PlaybackStateCompat.ACTION_PLAY_PAUSE or PlaybackStateCompat.ACTION_SKIP_TO_NEXT or
                PlaybackStateCompat.ACTION_SKIP_TO_PREVIOUS or PlaybackStateCompat.ACTION_FAST_FORWARD or
                PlaybackStateCompat.ACTION_REWIND or PlaybackStateCompat.ACTION_SEEK_TO)
            .setState(if (playing) PlaybackStateCompat.STATE_PLAYING else PlaybackStateCompat.STATE_PAUSED,
                PlaybackStateCompat.PLAYBACK_POSITION_UNKNOWN, 1f)
            .build())
        startForeground(NOTIF_ID, buildNotification(playing, title, artist))
        if (!playing) {
            // Stay in memory (audio can resume) but drop the "ongoing" lock so the row is dismissible.
            if (Build.VERSION.SDK_INT >= 24) stopForeground(STOP_FOREGROUND_DETACH) else @Suppress("DEPRECATION") stopForeground(false)
        }
    }

    private fun buildNotification(playing: Boolean, title: String, artist: String): Notification {
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= 26 && nm.getNotificationChannel(CHANNEL) == null)
            nm.createNotificationChannel(NotificationChannel(CHANNEL, "Playback", NotificationManager.IMPORTANCE_LOW))

        val openApp = PendingIntent.getActivity(this, 0,
            Intent(this, MainActivity::class.java).setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)

        fun action(icon: Int, label: String, code: Long) = NotificationCompat.Action(icon, label,
            MediaButtonReceiver.buildMediaButtonPendingIntent(this, code))

        return NotificationCompat.Builder(this, CHANNEL)
            .setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle(title.ifEmpty { getString(R.string.app_name) })
            .setContentText(artist)
            .setContentIntent(openApp)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setOnlyAlertOnce(true)
            .addAction(action(android.R.drawable.ic_media_previous, "Prev", PlaybackStateCompat.ACTION_SKIP_TO_PREVIOUS))
            .addAction(if (playing) action(android.R.drawable.ic_media_pause, "Pause", PlaybackStateCompat.ACTION_PAUSE)
                       else action(android.R.drawable.ic_media_play, "Play", PlaybackStateCompat.ACTION_PLAY))
            .addAction(action(android.R.drawable.ic_media_next, "Next", PlaybackStateCompat.ACTION_SKIP_TO_NEXT))
            .setStyle(androidx.media.app.NotificationCompat.MediaStyle()
                .setMediaSession(session!!.sessionToken)
                .setShowActionsInCompactView(0, 1, 2))
            .build()
    }

    companion object {
        private const val CHANNEL = "playback"
        private const val NOTIF_ID = 1
        const val EXTRA_PLAYING = "playing"
        const val EXTRA_TITLE = "title"
        const val EXTRA_ARTIST = "artist"

        @Volatile var session: MediaSessionCompat? = null
        // Set by MainActivity: runs a JS snippet in the WebView (media-button -> web player).
        @Volatile var controlSink: ((String) -> Unit)? = null
        private var started = false
        private var lastPlaying = false
        private var lastTitle = ""
        private var lastArtist = ""

        fun ensureSession(ctx: Context) {
            if (session != null) return
            session = MediaSessionCompat(ctx.applicationContext, "AppleMusicTV").apply {
                setCallback(object : MediaSessionCompat.Callback() {
                    override fun onPlay() { controlSink?.invoke("window.tvSetPlaying && tvSetPlaying(true)") }
                    override fun onPause() { controlSink?.invoke("window.tvSetPlaying && tvSetPlaying(false)") }
                    override fun onSkipToNext() { controlSink?.invoke("window.tvNext && tvNext()") }
                    override fun onSkipToPrevious() { controlSink?.invoke("window.tvPrev && tvPrev()") }
                    override fun onStop() { controlSink?.invoke("window.tvSetPlaying && tvSetPlaying(false)") }
                    // The system delivers the remote's FF/RW here, not to Activity.onKeyDown —
                    // but only if the actions above advertise them.
                    override fun onFastForward() { controlSink?.invoke("window.tvScrub && tvScrub(1)") }
                    override fun onRewind() { controlSink?.invoke("window.tvScrub && tvScrub(-1)") }
                    override fun onSeekTo(pos: Long) { controlSink?.invoke("window.tvSeekTo && tvSeekTo($pos)") }
                })
                isActive = true
            }
        }

        /** Called from the Activity's web bridge whenever the player's state changes. */
        fun push(ctx: Context, playing: Boolean, title: String, artist: String) {
            val i = Intent(ctx, PlaybackService::class.java)
                .putExtra(EXTRA_PLAYING, playing).putExtra(EXTRA_TITLE, title).putExtra(EXTRA_ARTIST, artist)
            if (Build.VERSION.SDK_INT >= 26) ctx.startForegroundService(i) else ctx.startService(i)
        }
    }
}

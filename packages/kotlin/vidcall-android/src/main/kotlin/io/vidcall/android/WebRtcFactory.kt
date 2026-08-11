package io.vidcall.android

import android.content.Context
import org.webrtc.Camera2Enumerator
import org.webrtc.CameraVideoCapturer
import org.webrtc.EglBase
import org.webrtc.MediaConstraints
import org.webrtc.PeerConnectionFactory
import org.webrtc.SurfaceTextureHelper
import org.webrtc.VideoCapturer
import org.webrtc.VideoSource
import org.webrtc.VideoTrack

/**
 * Bootstraps the pinned `io.getstream:stream-webrtc-android` build
 * (org.webrtc package) and creates local media.
 *
 * [PeerConnectionFactory.initialize] must run once per process; [createFactory]
 * handles that. Camera capture needs the app's CAMERA permission at runtime —
 * that stays app-side.
 */
object WebRtcFactory {

    @Volatile
    private var initialized = false

    fun initialize(context: Context) {
        if (initialized) return
        synchronized(this) {
            if (initialized) return
            PeerConnectionFactory.initialize(
                PeerConnectionFactory.InitializationOptions.builder(context.applicationContext)
                    .setEnableInternalTracer(false)
                    .createInitializationOptions(),
            )
            initialized = true
        }
    }

    fun createFactory(context: Context): PeerConnectionFactory {
        initialize(context)
        return PeerConnectionFactory.builder().createPeerConnectionFactory()
    }

    /** Create a local media bundle (mic + camera) ready to attach to peers. */
    fun createLocalMedia(
        context: Context,
        factory: PeerConnectionFactory,
        audioEnabled: Boolean = true,
        videoEnabled: Boolean = true,
        videoWidth: Int = 1280,
        videoHeight: Int = 720,
        videoFps: Int = 30,
    ): PeerConnectionManager.LocalMedia {
        val audioTrack = if (audioEnabled) {
            factory.createAudioTrack("vidcall-audio", factory.createAudioSource(MediaConstraints()))
        } else {
            null
        }
        var videoTrack: VideoTrack? = null
        if (videoEnabled) {
            val capturer = createCameraCapturer(context, front = true)
            if (capturer != null) {
                val source = factory.createVideoSource(false)
                attachCapturer(context, source, capturer, videoWidth, videoHeight, videoFps)
                videoTrack = factory.createVideoTrack("vidcall-video", source)
            }
        }
        return PeerConnectionManager.LocalMedia(audioTrack, videoTrack)
    }

    /** First matching front/back camera capturer, or null when unavailable. */
    fun createCameraCapturer(context: Context, front: Boolean = true): CameraVideoCapturer? {
        val enumerator = Camera2Enumerator(context)
        val name = enumerator.deviceNames.firstOrNull { enumerator.isFrontFacing(it) == front }
            ?: enumerator.deviceNames.firstOrNull()
            ?: return null
        return enumerator.createCapturer(name, null)
    }

    /**
     * Screen-sharing seam: an app-side capturer (e.g. MediaProjection-based)
     * can be attached to a [VideoSource] created with `isScreencast = true`.
     */
    fun createScreenVideoSource(factory: PeerConnectionFactory): VideoSource =
        factory.createVideoSource(true)

    fun createScreenTrack(factory: PeerConnectionFactory, source: VideoSource, label: String = "vidcall-screen"): VideoTrack =
        factory.createVideoTrack(label, source)

    /** Wire a capturer to a source and start capturing. */
    fun attachCapturer(
        context: Context,
        source: VideoSource,
        capturer: VideoCapturer,
        width: Int = 1280,
        height: Int = 720,
        fps: Int = 30,
    ) {
        val eglBase = EglBase.create()
        val helper = SurfaceTextureHelper.create("vidcall-capture", eglBase.eglBaseContext)
        capturer.initialize(helper, context.applicationContext, source.getCapturerObserver())
        capturer.startCapture(width, height, fps)
    }
}

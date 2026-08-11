# vidcall-android consumer rules.
# org.webrtc classes are consumed via the library AAR directly; keep them intact.
-keep class org.webrtc.** { *; }

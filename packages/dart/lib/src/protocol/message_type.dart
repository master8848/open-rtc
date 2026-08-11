/// Wire `type` values from `protocol/schema.json`.
///
/// The protocol is additive-only: clients must tolerate unknown `type`
/// strings (ignore + log). [`MessageType.tryParse`] returns `null` for those.
enum MessageType {
  join('join'),
  leave('leave'),
  offer('offer'),
  answer('answer'),
  ice('ice'),
  presence('presence'),
  reaction('reaction'),
  chat('chat'),
  screenShare('screen-share'),
  qualityWarning('quality-warning'),
  sfu('sfu'),
  error('error'),
  ping('ping'),
  pong('pong');

  const MessageType(this.wire);

  /// The exact string used on the wire.
  final String wire;

  /// Parses [wire] into a [MessageType], or `null` for unknown
  /// (forward-compatible) types.
  static MessageType? tryParse(String wire) {
    for (final type in MessageType.values) {
      if (type.wire == wire) {
        return type;
      }
    }
    return null;
  }

  @override
  String toString() => wire;
}

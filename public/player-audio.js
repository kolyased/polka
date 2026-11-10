// One cancellable metadata load per audio element. Call play in the tap handler,
// before awaiting metadata, so iOS can retain the user's playback gesture.
export function createAudioLoader(audio, timeoutMs = 20000) {
  let cancelPending = null;
  return {
    cancel() { cancelPending?.(); },
    load({src, time = 0, rate = 1, play = false, onPlayError = () => {}}) {
      cancelPending?.();
      const ready = new Promise((resolve, reject) => {
        let timeout;
        const cleanup = () => {
          clearTimeout(timeout);
          audio.removeEventListener('loadedmetadata', loaded);
          audio.removeEventListener('error', failed);
          if (cancelPending === cancel) cancelPending = null;
        };
        const finish = error => { cleanup(); error ? reject(error) : resolve(); };
        const cancel = () => finish(new DOMException('Загрузка заменена', 'AbortError'));
        const failed = () => finish(new Error('Не удалось загрузить аудио. Проверь соединение и нажми воспроизведение.'));
        const loaded = () => {
          try {
            audio.currentTime = Math.max(0, Math.min(time, Math.max(0, audio.duration - .05)));
            audio.playbackRate = rate;
            finish();
          } catch (error) { finish(error); }
        };
        cancelPending = cancel;
        audio.addEventListener('loadedmetadata', loaded);
        audio.addEventListener('error', failed);
        timeout = setTimeout(failed, timeoutMs);
        try { audio.src = src; audio.load(); } catch (error) { finish(error); }
      });
      // Buffering must not keep controls disabled after metadata has arrived.
      // Attach the rejection handler immediately, even if autoplay fails early.
      if (play) { try { Promise.resolve(audio.play()).catch(onPlayError); } catch (error) { onPlayError(error); } }
      return ready;
    }
  };
}

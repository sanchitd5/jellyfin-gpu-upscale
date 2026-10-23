using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Jellyfin.Data.Enums;
using Jellyfin.Database.Implementations.Entities;
using MediaBrowser.Controller;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Controller.Library;
using MediaBrowser.Controller.Plugins;
using MediaBrowser.Controller.Trickplay;
using MediaBrowser.Model.Tasks;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.Plus
{
    // Registers each recording's existing contact sheet (<name>.jpg: 90 thumbs of 320x240 in a 10x9 grid) as a
    // one-tile trickplay set, so the seek bar gets previews without another ffmpeg pass. The tile is a SYMLINK to
    // the sheet, not a copy (47k sheets would cost ~23 GB on the Jellyfin root disk).
    //
    // Jellyfin facts this relies on (decompiled from 12.1; re-read in the 12.3 sources: unchanged):
    //  - TrickplayController serves Videos/{id}/Trickplay/{width}/{index}.jpg from
    //    ITrickplayManager.GetTrickplayTilePathAsync = GetTrickplayDirectory(item, tileW, tileH, width, saveWithMedia)/{index}.jpg
    //    where saveWithMedia comes from the library option SaveTrickplayWithMedia (false here).
    //  - Neither that controller nor DtoService (ItemFields.Trickplay -> GetTrickplayManifest) checks
    //    EnableTrickplayImageExtraction; the DTO is built purely from TrickplayInfos rows.
    //  - TrickplayInfos is keyed (ItemId, Width); SaveTrickplayInfo replaces a row with the same key.
    //  - The web client picks the tile with index = floor(pos / Interval) / (TileWidth*TileHeight), so the interval
    //    is rounded UP: truncating could address a nonexistent second tile for the last few ms of the item.

    /// <summary>Attaches an item's contact sheet as its trickplay tile.</summary>
    public sealed class SheetTrickplay
    {
        public const int ThumbWidth = 320;
        public const int ThumbHeight = 240;
        public const int TileWidth = 10;
        public const int TileHeight = 9;
        public const int ThumbCount = TileWidth * TileHeight;

        private static readonly TimeSpan RootsTtl = TimeSpan.FromSeconds(60);

        private readonly ILibraryManager _library;
        private readonly ITrickplayManager _trickplay;
        private readonly ILogger<SheetTrickplay> _logger;
        private readonly object _rootsLock = new object();
        private string[] _roots = Array.Empty<string>();
        private DateTime _rootsAt = DateTime.MinValue;

        // Items known to be done, so repeated ItemUpdated events cost nothing. Bounded: cleared when large.
        private readonly ConcurrentDictionary<Guid, byte> _done = new ConcurrentDictionary<Guid, byte>();
        private readonly ConcurrentDictionary<Guid, byte> _inFlight = new ConcurrentDictionary<Guid, byte>();

        // IO misses (sheet missing/empty, not under a root), so a library scan's ItemUpdated storm does not re-stat
        // 47k files on the FUSE mount. Value is the expiry. The backfill task bypasses it.
        private static readonly TimeSpan NegativeTtl = TimeSpan.FromHours(6);
        private readonly ConcurrentDictionary<Guid, DateTime> _negative = new ConcurrentDictionary<Guid, DateTime>();

        public SheetTrickplay(ILibraryManager library, ITrickplayManager trickplay, ILogger<SheetTrickplay> logger)
        {
            _library = library;
            _trickplay = trickplay;
            _logger = logger;
        }

        /// <summary>In-memory only (no IO): false when an event for this item cannot lead to work.</summary>
        public bool WorthAttempting(Video item)
        {
            return item != null
                && item.RunTimeTicks.HasValue && item.RunTimeTicks.Value > 0
                && !_done.ContainsKey(item.Id)
                && !_inFlight.ContainsKey(item.Id)
                && !IsNegative(item.Id);
        }

        /// <summary>Forgets everything known about an item (it was removed; a re-add at the same path must reattach).</summary>
        public void Forget(Guid id)
        {
            _done.TryRemove(id, out _);
            _negative.TryRemove(id, out _);
        }

        private bool IsNegative(Guid id)
        {
            if (_negative.TryGetValue(id, out var expiry))
            {
                if (expiry > DateTime.UtcNow)
                {
                    return true;
                }

                _negative.TryRemove(id, out _);
            }

            return false;
        }

        private void RememberMiss(Guid id)
        {
            if (_negative.Count > 200000)
            {
                _negative.Clear();
            }

            _negative[id] = DateTime.UtcNow + NegativeTtl;
        }

        /// <summary>True when the item now has (or already had) sheet trickplay. Never throws.</summary>
        /// <param name="bypassNegativeCache">The scheduled backfill passes true so it re-checks IO misses.</param>
        public async Task<bool> TryAttachAsync(Video item, CancellationToken ct, bool bypassNegativeCache = false)
        {
            if (item == null || _done.ContainsKey(item.Id))
            {
                return false;
            }

            if (!bypassNegativeCache && IsNegative(item.Id))
            {
                return false;
            }

            if (!_inFlight.TryAdd(item.Id, 0))
            {
                return false;
            }

            string tileDir = null;
            bool linkCreated = false;
            try
            {
                var path = item.Path;
                var ticks = item.RunTimeTicks;
                if (!ticks.HasValue || ticks.Value <= 0)
                {
                    return false; // no IO, not cached: RunTimeTicks fills in after the probe
                }

                if (string.IsNullOrEmpty(path) || !item.IsFileProtocol || !UnderRoot(path))
                {
                    RememberMiss(item.Id);
                    return false;
                }

                var sheet = Path.ChangeExtension(path, ".jpg");
                var sheetInfo = new FileInfo(sheet);
                if (!sheetInfo.Exists || sheetInfo.Length == 0)
                {
                    RememberMiss(item.Id);
                    return false;
                }

                var existing = await _trickplay.GetTrickplayResolutions(item.Id).ConfigureAwait(false);
                if (existing != null && existing.Count > 0)
                {
                    // Already has trickplay (ours or Jellyfin's): nothing to do, remember it.
                    Remember(item.Id);
                    return false;
                }

                if (!ReadJpegSize(sheet, out var w, out var h) || w != ThumbWidth * TileWidth || h != ThumbHeight * TileHeight)
                {
                    _logger.LogDebug("Sheet trickplay: {Sheet} is {W}x{H}, not {EW}x{EH}; skipped", sheet, w, h, ThumbWidth * TileWidth, ThumbHeight * TileHeight);
                    // Older sheets use another layout and never change: remember the miss so every
                    // ItemUpdated does not re-read the header over the FUSE mount.
                    Remember(item.Id);
                    return false;
                }

                ct.ThrowIfCancellationRequested();

                var durationMs = ticks.Value / TimeSpan.TicksPerMillisecond;
                var interval = (int)Math.Min(int.MaxValue, Math.Max(1, (durationMs + ThumbCount - 1) / ThumbCount));

                tileDir = _trickplay.GetTrickplayDirectory(item, TileWidth, TileHeight, ThumbWidth, false);
                var tile = Path.Combine(tileDir, "0.jpg");
                Directory.CreateDirectory(tileDir);
                var tileInfo = new FileInfo(tile);
                if (tileInfo.LinkTarget != null)
                {
                    tileInfo.Delete();
                }
                else if (tileInfo.Exists)
                {
                    _logger.LogDebug("Sheet trickplay: {Tile} is a real file, left alone", tile);
                    return false;
                }

                File.CreateSymbolicLink(tile, sheetInfo.FullName);
                linkCreated = true;

                // Same formula as TrickplayManager: bytes*8 per thumbnail-second, ceiling.
                var bandwidth = (int)Math.Min(int.MaxValue, Math.Ceiling((decimal)sheetInfo.Length * 8m / TileWidth / TileHeight / (interval / 1000m)));

                await _trickplay.SaveTrickplayInfo(new TrickplayInfo
                {
                    ItemId = item.Id,
                    Width = ThumbWidth,
                    Height = ThumbHeight,
                    TileWidth = TileWidth,
                    TileHeight = TileHeight,
                    ThumbnailCount = ThumbCount,
                    Interval = interval,
                    Bandwidth = bandwidth
                }).ConfigureAwait(false);

                linkCreated = false;
                Remember(item.Id);
                _logger.LogDebug("Sheet trickplay: attached {Sheet} to {Path} (interval {Interval} ms)", sheet, path, interval);
                return true;
            }
            catch (OperationCanceledException)
            {
                return false;
            }
            catch (Exception ex)
            {
                _logger.LogDebug(ex, "Sheet trickplay: attach failed for {Path}", item.Path);
                return false;
            }
            finally
            {
                if (linkCreated && tileDir != null)
                {
                    try { File.Delete(Path.Combine(tileDir, "0.jpg")); } catch { }
                }

                _inFlight.TryRemove(item.Id, out _);
            }
        }

        private void Remember(Guid id)
        {
            if (_done.Count > 200000)
            {
                _done.Clear();
            }

            _done[id] = 0;
        }

        private bool UnderRoot(string path)
        {
            string[] roots;
            lock (_rootsLock)
            {
                if (DateTime.UtcNow - _rootsAt > RootsTtl)
                {
                    try
                    {
                        _roots = _library.GetVirtualFolders()
                            .SelectMany(f => f.Locations ?? Array.Empty<string>())
                            .Where(l => !string.IsNullOrEmpty(l))
                            .Select(l => l.TrimEnd('/', '\\') + Path.DirectorySeparatorChar)
                            .ToArray();
                    }
                    catch (Exception ex)
                    {
                        _logger.LogDebug(ex, "Sheet trickplay: reading library roots failed");
                    }

                    _rootsAt = DateTime.UtcNow;
                }

                roots = _roots;
            }

            return roots.Any(r => path.StartsWith(r, StringComparison.Ordinal));
        }

        /// <summary>Reads the pixel size from the JPEG's SOF marker; no decoding.</summary>
        internal static bool ReadJpegSize(string file, out int width, out int height)
        {
            width = 0;
            height = 0;
            try
            {
                using var fs = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
                var buf = new byte[65536];
                var n = fs.Read(buf, 0, buf.Length);
                if (n < 4 || buf[0] != 0xFF || buf[1] != 0xD8)
                {
                    return false;
                }

                var i = 2;
                while (i + 4 <= n)
                {
                    if (buf[i] != 0xFF)
                    {
                        i++;
                        continue;
                    }

                    var m = buf[i + 1];
                    if (m == 0xFF)
                    {
                        i++; // fill byte
                        continue;
                    }

                    if (m == 0x00 || m == 0x01 || (m >= 0xD0 && m <= 0xD8))
                    {
                        i += 2; // no length field
                        continue;
                    }

                    if (m == 0xD9 || m == 0xDA)
                    {
                        return false; // end / scan before any frame header
                    }

                    var len = (buf[i + 2] << 8) | buf[i + 3];
                    if (m >= 0xC0 && m <= 0xCF && m != 0xC4 && m != 0xC8 && m != 0xCC)
                    {
                        if (i + 9 > n)
                        {
                            return false;
                        }

                        height = (buf[i + 5] << 8) | buf[i + 6];
                        width = (buf[i + 7] << 8) | buf[i + 8];
                        return true;
                    }

                    i += 2 + len;
                }
            }
            catch
            {
            }

            return false;
        }
    }

    /// <summary>Registers the sheet-trickplay services.</summary>
    public class SheetTrickplayServiceRegistrator : IPluginServiceRegistrator
    {
        /// <inheritdoc />
        public void RegisterServices(IServiceCollection serviceCollection, IServerApplicationHost applicationHost)
        {
            serviceCollection.AddSingleton<SheetTrickplay>();
            serviceCollection.AddHostedService<SheetTrickplayHostedService>();
        }
    }

    /// <summary>Attaches new and freshly probed Video items (RunTimeTicks is usually filled after ItemAdded, so ItemUpdated is watched too).</summary>
    public sealed class SheetTrickplayHostedService : IHostedService
    {
        private readonly ILibraryManager _library;
        private readonly SheetTrickplay _sheet;
        private const int MaxPending = 500;
        private readonly ILogger<SheetTrickplayHostedService> _logger;
        private readonly SemaphoreSlim _gate = new SemaphoreSlim(2);
        private readonly CancellationTokenSource _cts = new CancellationTokenSource();
        private int _pending;
        private long _lastDropLogTicks;

        public SheetTrickplayHostedService(ILibraryManager library, SheetTrickplay sheet, ILogger<SheetTrickplayHostedService> logger)
        {
            _library = library;
            _sheet = sheet;
            _logger = logger;
        }

        public Task StartAsync(CancellationToken cancellationToken)
        {
            _library.ItemAdded += OnItem;
            _library.ItemUpdated += OnItem;
            _library.ItemRemoved += OnRemoved;
            return Task.CompletedTask;
        }

        public Task StopAsync(CancellationToken cancellationToken)
        {
            _library.ItemAdded -= OnItem;
            _library.ItemUpdated -= OnItem;
            _library.ItemRemoved -= OnRemoved;
            _cts.Cancel();
            return Task.CompletedTask;
        }

        private void OnRemoved(object sender, ItemChangeEventArgs e)
        {
            if (e?.Item != null)
            {
                _sheet.Forget(e.Item.Id);
            }
        }

        private void OnItem(object sender, ItemChangeEventArgs e)
        {
            // A full library scan fires this for every item: in-memory pre-checks only, before any Task.Run.
            if (e?.Item is Video video && _sheet.WorthAttempting(video))
            {
                if (Interlocked.Increment(ref _pending) > MaxPending)
                {
                    Interlocked.Decrement(ref _pending);
                    var now = DateTime.UtcNow.Ticks;
                    var last = Interlocked.Read(ref _lastDropLogTicks);
                    if (now - last > TimeSpan.TicksPerMinute && Interlocked.CompareExchange(ref _lastDropLogTicks, now, last) == last)
                    {
                        _logger.LogDebug("Sheet trickplay: more than {Max} events pending, dropping; the scheduled backfill covers them", MaxPending);
                    }

                    return;
                }

                _ = Task.Run(async () =>
                {
                    try
                    {
                        try
                        {
                            await _gate.WaitAsync(_cts.Token).ConfigureAwait(false);
                        }
                        catch (OperationCanceledException)
                        {
                            return;
                        }

                        try
                        {
                            await _sheet.TryAttachAsync(video, _cts.Token).ConfigureAwait(false);
                        }
                        catch
                        {
                        }
                        finally
                        {
                            _gate.Release();
                        }
                    }
                    finally
                    {
                        Interlocked.Decrement(ref _pending);
                    }
                });
            }
        }
    }

    /// <summary>Dashboard > Scheduled Tasks > Run: backfills every Video lacking trickplay from its contact sheet.</summary>
    public sealed class SheetTrickplayImportTask : IScheduledTask
    {
        private const int Page = 500;
        private readonly ILibraryManager _library;
        private readonly SheetTrickplay _sheet;
        private readonly ILogger<SheetTrickplayImportTask> _logger;

        public SheetTrickplayImportTask(ILibraryManager library, SheetTrickplay sheet, ILogger<SheetTrickplayImportTask> logger)
        {
            _library = library;
            _sheet = sheet;
            _logger = logger;
        }

        /// <inheritdoc />
        public string Name => "Jellyfin Plus: import contact sheets as trickplay";

        /// <inheritdoc />
        public string Key => "JellyfinPlusSheetTrickplayImport";

        /// <inheritdoc />
        public string Description => "Registers each video's existing 10x9 contact sheet (<name>.jpg) as its seek-bar preview, with no ffmpeg pass. Videos that already have trickplay are skipped. New videos are handled automatically.";

        /// <inheritdoc />
        public string Category => "Library";

        /// <inheritdoc />
        public async Task ExecuteAsync(IProgress<double> progress, CancellationToken cancellationToken)
        {
            var ids = _library.GetItemIds(new InternalItemsQuery
            {
                IncludeItemTypes = new[] { BaseItemKind.Video, BaseItemKind.Movie, BaseItemKind.Episode, BaseItemKind.MusicVideo },
                Recursive = true,
                IsVirtualItem = false
            });

            var total = ids.Count;
            var attached = 0;
            for (var i = 0; i < total; i++)
            {
                cancellationToken.ThrowIfCancellationRequested();
                try
                {
                    if (_library.GetItemById(ids[i]) is Video v && await _sheet.TryAttachAsync(v, cancellationToken, bypassNegativeCache: true).ConfigureAwait(false))
                    {
                        attached++;
                    }
                }
                catch (OperationCanceledException)
                {
                    throw;
                }
                catch (Exception ex)
                {
                    _logger.LogDebug(ex, "Sheet trickplay import: item {Id} failed", ids[i]);
                }

                if (i % 50 == 0)
                {
                    progress.Report(100.0 * i / total);
                }
            }

            progress.Report(100);
            _logger.LogInformation("Sheet trickplay import: attached {Attached} of {Total} items", attached, total);
        }

        /// <inheritdoc />
        public IEnumerable<TaskTriggerInfo> GetDefaultTriggers() => Array.Empty<TaskTriggerInfo>();
    }
}

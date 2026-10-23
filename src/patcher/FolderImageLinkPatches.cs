using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using HarmonyLib;
using Jellyfin.Data.Enums;
using Jellyfin.Database.Implementations.Enums;
using MediaBrowser.Controller.Dto;
using MediaBrowser.Controller.Entities;
using MediaBrowser.Model.Entities;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.Plus.Patcher
{
    /// <summary>
    /// Folder covers become symlinks to the child image they copy, instead of a second copy of it.
    ///
    /// THE COPY. A Folder (one per recording day-folder here) with no image of its own gets one from
    /// FolderImageProvider: BaseFolderImageProvider.GetItemsWithImages picks the first child with a
    /// Primary image (recursive, IsFolder ascending then SortName, Limit 1), CreateSingleImage
    /// File.Copy's that image to a temp file, and ProviderManager.SaveImage streams the temp file
    /// through ImageSaver into metadata/library/../poster.jpg. Each child's Primary is a 2-3 MB contact
    /// sheet beside the media, so every day-folder carries a byte-for-byte duplicate of one.
    ///
    /// WHY NOT CreateSingleImage. It is the obvious seam, but its output is only a TEMP file:
    /// ImageSaver then reads that file and writes the bytes into the metadata directory with its own
    /// FileStream. A symlink at the temp path would still be copied. (It is also a non-generic
    /// method on the generic BaseDynamicImageProvider of T, which is the shape AGENTS.md records as
    /// awkward to patch.) The seam is ImageSaver instead - a plain non-generic class - in two places:
    ///
    ///   1. SetImagePath(item, type, index, path), prefix. Runs after the bytes are on disk and
    ///      BEFORE Jellyfin records the image. For an exact Folder's Primary under its own internal
    ///      metadata path, it re-runs stock's child pick, and only if that child's image is a local
    ///      file outside Jellyfin's own directories AND byte-identical to what was just written, it
    ///      atomically replaces the copy with a symlink to it (temp link + rename). The original
    ///      then stores FileSystem.GetFileInfo(link), which Jellyfin resolves to the TARGET's mtime
    ///      and length (ManagedFileSystem.GetFileSystemMetadata follows links).
    ///
    ///   2. SaveImageToLocation(stream, path, token), prefix: THE WRITE GUARD. ImageSaver opens the
    ///      destination with FileMode.Create, which follows a symlink and truncates its target. A
    ///      later regeneration of a linked folder cover would therefore write INTO the library's
    ///      contact sheet - and, if the child pick had changed meanwhile, overwrite one sheet with
    ///      another. So before any write to a path under the internal metadata directory that is a
    ///      symlink, the link itself is deleted; if it cannot be, the write is refused with an
    ///      IOException rather than allowed through. The guard is installed first and the link
    ///      patch only if the guard is in place; the conversion task refuses to run without it.
    ///
    /// REGENERATION. HasChangedByDate compares the stored DateModified with
    /// FileSystem.GetLastWriteTimeUtc(path); both resolve the link to the target, so a link is as
    /// stable as a copy and is not regenerated on every refresh. When the target changes, the dates
    /// differ and Jellyfin regenerates (guard removes the link, stock writes a copy, patch 1 relinks).
    /// When the target is deleted, the dangling link reports its own mtime (or the image is dropped as
    /// missing), which differs from the stored target mtime, so Jellyfin regenerates rather than
    /// serving a broken image. The link's own mtime is deliberately left alone for exactly that.
    ///
    /// Fail-soft: any exception in either prefix leaves the stock behaviour (a copy).
    /// </summary>
    internal static class FolderImageLinkPatches
    {
        private const string Linked = "linked";

        private static ILogger _logger;
        private static int _running;
        private static MethodInfo _write;
        private static MethodInfo _guard;

        /// <summary>
        /// True while the write guard is installed (links are never written through). Read from
        /// Harmony's live patch table, not a flag, so a later UnpatchAll cannot leave it stale.
        /// </summary>
        public static bool GuardActive
        {
            get
            {
                try
                {
                    return _write != null && _guard != null
                        && Harmony.GetPatchInfo(_write)?.Prefixes.Any(p => p.PatchMethod == _guard) == true;
                }
                catch (Exception)
                {
                    return false;
                }
            }
        }

        /// <summary>True when new folder covers are linked (guard + link patch both installed).</summary>
        public static bool Available { get; private set; }

        public static void Apply(Harmony harmony, ILogger logger)
        {
            _logger = logger;

            // Resolved BY NAME: no compile-time reference to MediaBrowser.Providers.
            var saver = AccessTools.TypeByName("MediaBrowser.Providers.Manager.ImageSaver");
            var write = saver == null ? null : AccessTools.Method(
                saver, "SaveImageToLocation", new[] { typeof(Stream), typeof(string), typeof(CancellationToken) });
            var setPath = saver == null ? null : AccessTools.Method(
                saver, "SetImagePath", new[] { typeof(BaseItem), typeof(ImageType), typeof(int?), typeof(string) });

            if (write == null || setPath == null || write.ReturnType != typeof(Task) || setPath.ReturnType != typeof(void))
            {
                logger?.LogWarning(
                    "JellyfinPlus: could not resolve ImageSaver.SaveImageToLocation / SetImagePath; folder images stay copies (stock).");
                return;
            }

            var guard = typeof(FolderImageLinkPatches).GetMethod(nameof(SaveImageToLocationPrefix), BindingFlags.Static | BindingFlags.NonPublic);
            harmony.Patch(write, prefix: new HarmonyMethod(guard));
            _write = write;
            _guard = guard;
            if (!GuardActive)
            {
                logger?.LogWarning("JellyfinPlus: the image write guard did not register; folder images stay copies (stock).");
                return;
            }

            harmony.Patch(setPath, prefix: new HarmonyMethod(
                typeof(FolderImageLinkPatches).GetMethod(nameof(SetImagePathPrefix), BindingFlags.Static | BindingFlags.NonPublic)));
            Available = true;

            logger?.LogInformation("JellyfinPlus: patched ImageSaver (folder images link to the child image instead of copying it; writes never go through a link)");
        }

        /// <summary>The write guard. Parameter names match the original's.</summary>
        private static bool SaveImageToLocationPrefix(string path, ref Task __result)
        {
            try
            {
                if (string.IsNullOrEmpty(path) || new FileInfo(path).LinkTarget == null)
                {
                    return true;
                }

                var root = BaseItem.ConfigurationManager?.ApplicationPaths?.InternalMetadataPath;
                if (string.IsNullOrEmpty(root) || !IsUnder(path, root))
                {
                    // Not one of ours: stock behaviour, whatever it is.
                    return true;
                }
            }
            catch (Exception ex)
            {
                _logger?.LogDebug(ex, "JellyfinPlus: folder image write guard could not inspect {Path}", path);
                return true;
            }

            try
            {
                File.Delete(path); // unlinks the symlink; never touches its target
                _logger?.LogDebug("JellyfinPlus: removed image link {Path} before Jellyfin writes there", path);
                return true;
            }
            catch (Exception ex)
            {
                // Letting the original run now would write THROUGH the link into the library file.
                _logger?.LogWarning(ex, "JellyfinPlus: could not remove image link {Path}; refusing the write rather than writing through it", path);
                __result = Task.FromException(new IOException("Jellyfin Plus: could not remove the image link at " + path + "; refusing to write through it.", ex));
                return false;
            }
        }

        /// <summary>Links a freshly saved folder cover. Parameter names match the original's.</summary>
        private static void SetImagePathPrefix(BaseItem item, ImageType type, int? imageIndex, string path)
        {
            try
            {
                if (type != ImageType.Primary || (imageIndex ?? 0) != 0 || item == null || item.GetType() != typeof(Folder) || !GuardActive)
                {
                    return;
                }

                string outcome = TryLink(item, path, scanFolder: false, dryRun: false, out _);
                _logger?.LogDebug("JellyfinPlus: folder image {Path}: {Outcome}", path, outcome);
            }
            catch (Exception ex)
            {
                _logger?.LogDebug(ex, "JellyfinPlus: folder image link failed for {Path}; keeping the copy", path);
            }
        }

        /// <summary>
        /// The one-off conversion behind the two scheduled tasks. Every exact Folder whose Primary is a
        /// regular file in its internal metadata directory is compared with stock's child pick, then
        /// with the same-extension files in the folder's own directory; a byte-identical match replaces
        /// the copy with a link (same path, so the DB row stays valid) and the image record is refreshed
        /// so its DateModified is the target's. Dry run does every check, including the byte compare,
        /// and writes nothing. Idempotent: existing links are skipped.
        /// </summary>
        public static async Task<string> ConvertAsync(bool dryRun, IProgress<double> progress, CancellationToken cancellationToken)
        {
            if (!dryRun && !GuardActive)
            {
                throw new InvalidOperationException(
                    "Jellyfin Plus: the image write guard is not installed on this server, so linked folder images would be unsafe. Nothing was changed.");
            }

            var libraryManager = BaseItem.LibraryManager
                ?? throw new InvalidOperationException("Jellyfin Plus: the library manager is not available yet.");

            if (Interlocked.Exchange(ref _running, 1) == 1)
            {
                throw new InvalidOperationException("Jellyfin Plus: a folder image conversion is already running.");
            }

            try
            {
                var ids = libraryManager.GetItemIds(new InternalItemsQuery
                {
                    IncludeItemTypes = [BaseItemKind.Folder],
                    Recursive = true,
                });

                var outcomes = new ConcurrentDictionary<string, int>(StringComparer.Ordinal);
                long freed = 0;
                int done = 0;
                int total = ids.Count;

                var options = new ParallelOptions { MaxDegreeOfParallelism = 2, CancellationToken = cancellationToken };
                await Parallel.ForEachAsync(ids, options, async (id, token) =>
                {
                    string outcome;
                    long bytes = 0;
                    try
                    {
                        var item = libraryManager.GetItemById(id);
                        var image = item?.GetType() == typeof(Folder) ? item.GetImageInfo(ImageType.Primary, 0) : null;
                        if (item == null || item.GetType() != typeof(Folder))
                        {
                            outcome = "not-a-folder";
                        }
                        else if (image == null)
                        {
                            outcome = "no-image";
                        }
                        else if (!image.IsLocalFile)
                        {
                            outcome = "remote-image";
                        }
                        else
                        {
                            outcome = TryLink(item, image.Path, scanFolder: true, dryRun, out bytes);
                            if (outcome == Linked && !dryRun)
                            {
                                try
                                {
                                    // Records the target's DateModified (and re-reads size and blurhash), so the
                                    // next refresh does not see a changed date and regenerate the cover.
                                    await libraryManager.UpdateImagesAsync(item).ConfigureAwait(false);
                                }
                                catch (Exception ex)
                                {
                                    _logger?.LogDebug(ex, "JellyfinPlus: linked {Path} but could not refresh its image record", image.Path);
                                }
                            }
                        }
                    }
                    catch (OperationCanceledException)
                    {
                        throw;
                    }
                    catch (Exception ex)
                    {
                        outcome = "error";
                        _logger?.LogDebug(ex, "JellyfinPlus: folder image conversion failed for item {Id}", id);
                    }

                    outcomes.AddOrUpdate(outcome, 1, (_, c) => c + 1);
                    if (outcome == Linked)
                    {
                        Interlocked.Add(ref freed, bytes);
                    }

                    int n = Interlocked.Increment(ref done);
                    if (n % 100 == 0)
                    {
                        progress?.Report(100.0 * n / Math.Max(1, total));
                    }
                }).ConfigureAwait(false);

                progress?.Report(100);

                int linked = outcomes.TryGetValue(Linked, out var l) ? l : 0;
                var skipped = outcomes.Where(kv => kv.Key != Linked).OrderBy(kv => kv.Key, StringComparer.Ordinal)
                    .ToDictionary(kv => kv.Key, kv => kv.Value);
                string json = JsonSerializer.Serialize(new
                {
                    DryRun = dryRun,
                    Scanned = total,
                    Linked = linked,
                    BytesFreed = freed,
                    Skipped = skipped,
                });

                _logger?.LogInformation(
                    "JellyfinPlus: folder images {Mode}: {Scanned} folders scanned, {Linked} {Verb}, {MiB} MiB {Freed}; skipped {Skipped}",
                    dryRun ? "dry run" : "conversion",
                    total,
                    linked,
                    dryRun ? "would be linked" : "linked",
                    freed / (1024 * 1024),
                    dryRun ? "would be freed" : "freed",
                    string.Join(", ", skipped.Select(kv => kv.Key + "=" + kv.Value)));

                return json;
            }
            finally
            {
                Interlocked.Exchange(ref _running, 0);
            }
        }

        /// <summary>
        /// Replaces the folder cover at <paramref name="imagePath"/> with a link to the image it is a
        /// copy of, if and only if one is proven byte-identical. Returns "linked" or a skip reason.
        /// </summary>
        internal static string TryLink(BaseItem item, string imagePath, bool scanFolder, bool dryRun, out long bytes)
        {
            bytes = 0;
            if (string.IsNullOrEmpty(imagePath))
            {
                return "no-image";
            }

            if (!IsUnder(imagePath, item.GetInternalMetadataPath()))
            {
                return "not-in-metadata";
            }

            var image = new FileInfo(imagePath);
            if (image.LinkTarget != null)
            {
                return "already-linked";
            }

            if (!image.Exists)
            {
                return "image-missing";
            }

            var roots = ProtectedRoots();
            if (roots.Length == 0)
            {
                return "paths-unknown";
            }

            long length = image.Length;
            string reason = "no-source";
            foreach (var candidate in Candidates(item, scanFolder, Path.GetExtension(imagePath)))
            {
                var target = Resolve(candidate);
                if (target == null)
                {
                    reason = Worse(reason, "source-missing");
                    continue;
                }

                if (roots.Any(r => IsUnder(target, r)))
                {
                    reason = Worse(reason, "source-in-jellyfin-dirs");
                    continue;
                }

                if (new FileInfo(target).Length != length)
                {
                    reason = Worse(reason, "size-differs");
                    continue;
                }

                if (!SameBytes(imagePath, target))
                {
                    reason = Worse(reason, "content-differs");
                    continue;
                }

                if (!dryRun)
                {
                    ReplaceWithLink(imagePath, target);
                }

                bytes = length;
                return Linked;
            }

            return reason;
        }

        /// <summary>Stock's pick first, then (conversion only) same-extension files beside the folder.</summary>
        private static IEnumerable<string> Candidates(BaseItem item, bool scanFolder, string extension)
        {
            var seen = new HashSet<string>(StringComparer.Ordinal);
            var pick = StockPick(item);
            if (!string.IsNullOrEmpty(pick) && seen.Add(pick))
            {
                yield return pick;
            }

            if (!scanFolder || string.IsNullOrEmpty(extension) || !item.IsFileProtocol
                || string.IsNullOrEmpty(item.Path) || !Directory.Exists(item.Path))
            {
                yield break;
            }

            foreach (var file in Directory.EnumerateFiles(item.Path, "*" + extension, SearchOption.TopDirectoryOnly)
                .OrderBy(f => f, StringComparer.Ordinal))
            {
                if (seen.Add(file))
                {
                    yield return file;
                }
            }
        }

        /// <summary>BaseFolderImageProvider.GetItemsWithImages + CreateSingleImage's filter, as of 12.3.</summary>
        private static string StockPick(BaseItem item)
        {
            var libraryManager = BaseItem.LibraryManager;
            if (libraryManager == null)
            {
                return null;
            }

            var items = libraryManager.GetItemList(new InternalItemsQuery
            {
                Parent = item,
                Recursive = true,
                DtoOptions = new DtoOptions(true),
                ImageTypes = [ImageType.Primary],
                OrderBy =
                [
                    (ItemSortBy.IsFolder, SortOrder.Ascending),
                    (ItemSortBy.SortName, SortOrder.Ascending)
                ],
                Limit = 1
            });

            return items
                .Where(i => i.HasImage(ImageType.Primary) && i.GetImageInfo(ImageType.Primary, 0).IsLocalFile && Path.HasExtension(i.GetImagePath(ImageType.Primary)))
                .Select(i => i.GetImagePath(ImageType.Primary))
                .FirstOrDefault();
        }

        /// <summary>The existing file a candidate finally names (following links), or null.</summary>
        private static string Resolve(string candidate)
        {
            var info = new FileInfo(Path.GetFullPath(candidate));
            if (info.LinkTarget == null)
            {
                return info.Exists ? info.FullName : null;
            }

            var final = File.ResolveLinkTarget(info.FullName, returnFinalTarget: true);
            return final != null && final.Exists && final is FileInfo ? final.FullName : null;
        }

        /// <summary>Jellyfin's own data, metadata, cache and program directories: never a link target.</summary>
        private static string[] ProtectedRoots()
        {
            var p = BaseItem.ConfigurationManager?.ApplicationPaths;
            if (p == null)
            {
                return Array.Empty<string>();
            }

            return new[]
            {
                p.ProgramDataPath, p.DataPath, p.CachePath, p.ImageCachePath, p.TempDirectory, p.InternalMetadataPath,
                p.TrickplayPath, p.LogDirectoryPath, p.ConfigurationDirectoryPath, p.PluginsPath, p.ProgramSystemPath, p.WebPath,
            }.Where(r => !string.IsNullOrEmpty(r)).ToArray();
        }

        internal static bool IsUnder(string path, string root)
        {
            if (string.IsNullOrEmpty(path) || string.IsNullOrEmpty(root))
            {
                return false;
            }

            string full = Path.GetFullPath(path);
            string dir = Path.TrimEndingDirectorySeparator(Path.GetFullPath(root)) + Path.DirectorySeparatorChar;
            return full.StartsWith(dir, StringComparison.Ordinal);
        }

        /// <summary>Full streaming compare; lengths are already known equal.</summary>
        internal static bool SameBytes(string a, string b)
        {
            const int Buffer = 1 << 20;
            using var fa = new FileStream(a, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete, 1, FileOptions.SequentialScan);
            using var fb = new FileStream(b, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete, 1, FileOptions.SequentialScan);
            if (fa.Length != fb.Length)
            {
                return false;
            }

            var ba = new byte[Buffer];
            var bb = new byte[Buffer];
            while (true)
            {
                int na = fa.ReadAtLeast(ba, Buffer, throwOnEndOfStream: false);
                int nb = fb.ReadAtLeast(bb, Buffer, throwOnEndOfStream: false);
                if (na != nb || !ba.AsSpan(0, na).SequenceEqual(bb.AsSpan(0, nb)))
                {
                    return false;
                }

                if (na < Buffer)
                {
                    return true;
                }
            }
        }

        /// <summary>A link under a temp name, renamed over the copy: readers see the copy or the link, never neither.</summary>
        internal static void ReplaceWithLink(string path, string target)
        {
            string temp = Path.Combine(
                Path.GetDirectoryName(path),
                "." + Path.GetFileName(path) + ".jplink-" + Guid.NewGuid().ToString("N"));
            try
            {
                File.CreateSymbolicLink(temp, target);
                File.Move(temp, path, overwrite: true);
            }
            finally
            {
                try
                {
                    if (new FileInfo(temp).LinkTarget != null)
                    {
                        File.Delete(temp);
                    }
                }
                catch (Exception)
                {
                    // a stray dot-file link is harmless
                }
            }
        }

        // The most informative reason wins when several candidates fail differently.
        private static readonly string[] _reasonOrder = { "no-source", "source-missing", "source-in-jellyfin-dirs", "size-differs", "content-differs" };

        private static string Worse(string current, string next)
            => Array.IndexOf(_reasonOrder, next) > Array.IndexOf(_reasonOrder, current) ? next : current;
    }
}

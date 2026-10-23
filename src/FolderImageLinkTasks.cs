using System;
using System.Collections.Generic;
using System.Threading;
using System.Threading.Tasks;
using MediaBrowser.Model.Tasks;

namespace Jellyfin.Plugin.Plus
{
    // The conversion lives in the patcher (FolderImageLinkPatches.ConvertAsync), beside the write
    // guard it depends on; these are only the two dashboard entries. A second task for the dry run
    // avoids adding a setting. Both log a one-line summary (folders scanned, linked, skipped by
    // reason, bytes freed) and the real run fails, changing nothing, if the guard is not installed.

    /// <summary>Dashboard > Scheduled Tasks: replaces folder-cover copies with links to the identical child image.</summary>
    public sealed class FolderImageLinkTask : IScheduledTask
    {
        /// <inheritdoc />
        public string Name => "Jellyfin Plus: link folder images instead of copies";

        /// <inheritdoc />
        public string Key => "JellyfinPlusFolderImageLink";

        /// <inheritdoc />
        public string Description => "Replaces each folder's cover image, when it is a byte-identical copy of a child's image, with a link to that image. Frees the disk the copies use; anything not proven identical is left alone. Safe to re-run.";

        /// <inheritdoc />
        public string Category => "Library";

        /// <inheritdoc />
        public Task ExecuteAsync(IProgress<double> progress, CancellationToken cancellationToken)
            => PatcherLoader.FolderImageLink(false, progress, cancellationToken);

        /// <inheritdoc />
        public IEnumerable<TaskTriggerInfo> GetDefaultTriggers() => Array.Empty<TaskTriggerInfo>();
    }

    /// <summary>The same checks, including the byte compare, writing nothing: counts only (see the server log).</summary>
    public sealed class FolderImageLinkDryRunTask : IScheduledTask
    {
        /// <inheritdoc />
        public string Name => "Jellyfin Plus: link folder images instead of copies (dry run)";

        /// <inheritdoc />
        public string Key => "JellyfinPlusFolderImageLinkDryRun";

        /// <inheritdoc />
        public string Description => "Counts the folder cover images that would be replaced by links, and the disk that would free, without changing anything. The summary is written to the server log.";

        /// <inheritdoc />
        public string Category => "Library";

        /// <inheritdoc />
        public Task ExecuteAsync(IProgress<double> progress, CancellationToken cancellationToken)
            => PatcherLoader.FolderImageLink(true, progress, cancellationToken);

        /// <inheritdoc />
        public IEnumerable<TaskTriggerInfo> GetDefaultTriggers() => Array.Empty<TaskTriggerInfo>();
    }
}

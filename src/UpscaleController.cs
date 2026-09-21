using System;
using System.Globalization;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;

namespace Jellyfin.Plugin.GpuUpscale
{
    /// <summary>Status and recent-activity endpoint backing the dashboard page.</summary>
    [ApiController]
    [Authorize]
    [Route("GpuUpscale")]
    public class UpscaleController : ControllerBase
    {
        /// <summary>Gets the patch status and the recent sessions.</summary>
        [HttpGet("Status")]
        [Authorize(Policy = "RequiresElevation")]
        [ProducesResponseType(StatusCodes.Status200OK)]
        public ContentResult GetStatus()
        {
            return new ContentResult
            {
                Content = PatcherLoader.StatusJson(),
                ContentType = "application/json",
                StatusCode = StatusCodes.Status200OK,
            };
        }

        /// <summary>
        /// Reports what the server actually did for one play session. Answers for the caller's own
        /// session; for anyone else's it reports unknown rather than leaking that the session
        /// exists, so it is not behind RequiresElevation.
        /// </summary>
        /// <param name="playSessionId">The PlaySessionId of the stream.</param>
        [HttpGet("Session/{playSessionId}")]
        [ProducesResponseType(StatusCodes.Status200OK)]
        public ContentResult GetSession([FromRoute] string playSessionId)
        {
            string requestingUserId = null;
            string claim = User.FindFirst("Jellyfin-UserId")?.Value;
            if (!string.IsNullOrEmpty(claim) && Guid.TryParse(claim, out Guid userId))
            {
                requestingUserId = userId.ToString("N", CultureInfo.InvariantCulture);
            }

            return new ContentResult
            {
                Content = PatcherLoader.SessionJson(playSessionId, requestingUserId),
                ContentType = "application/json",
                StatusCode = StatusCodes.Status200OK,
            };
        }
    }
}

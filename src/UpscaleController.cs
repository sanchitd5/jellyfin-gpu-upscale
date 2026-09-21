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
        /// Reports what the server actually did for one play session. Any signed-in viewer may call
        /// this for the session they are watching, so it is not behind RequiresElevation.
        /// </summary>
        /// <param name="playSessionId">The PlaySessionId of the stream.</param>
        [HttpGet("Session/{playSessionId}")]
        [ProducesResponseType(StatusCodes.Status200OK)]
        public ContentResult GetSession([FromRoute] string playSessionId)
        {
            return new ContentResult
            {
                Content = PatcherLoader.SessionJson(playSessionId),
                ContentType = "application/json",
                StatusCode = StatusCodes.Status200OK,
            };
        }
    }
}

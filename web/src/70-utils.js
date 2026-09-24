    function el(tag, cls, text) {
        var n = document.createElement(tag);
        if (cls) { n.className = cls; }
        if (text != null) { n.textContent = text; }
        return n;
    }

    /*
     * AXES THAT CANNOT BOTH BE ON, AS DATA.
     *
     * The server already resolves every one of these: it forces the super-resolution level off when
     * a game upscaler produced the output size, drops the separate unblur pass for a shader that
     * sharpens inside its own, and has nothing for a refinement pass to correct when nothing was
     * enlarged. It resolves them silently, though, so the panel went on offering a control whose
     * value the server was about to discard. That is the dead-control failure wearing a different
     * hat: the pick is real, it is sent, and it changes nothing.
     *
     * Each rule names the axis it disables, when, and why in the words a viewer needs. `when` reads
     * only the current selection and the source, so nothing here needs the server to answer first.
     * A new conflict is one entry.
     */
